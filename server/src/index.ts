import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { PrismaClient, Role } from '@prisma/client';
import { z } from 'zod';
import crypto from 'node:crypto';

const prisma = new PrismaClient();
const app = express();
const isProd = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET minimal 32 karakter wajib diatur pada production.');
}
app.use(session({ name: 'juzara.sid', secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-now', resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax', maxAge: 1000 * 60 * 60 * 8 } }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

declare module 'express-session' { interface SessionData { userId?: string; role?: Role } }
const asyncRoute = (fn: any) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req,res,next)).catch(next);
const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => req.session.userId ? next() : res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
const requireRole = (...roles: Role[]) => (req: express.Request, res: express.Response, next: express.NextFunction) => { if (!req.session.userId) return res.status(401).json({error:'Unauthenticated'}); if (!roles.includes(req.session.role!)) return res.status(403).json({error:'Akses tidak diizinkan.'}); next(); };
const audit = (actorUserId: string | undefined, action: string, entityType: string, entityId?: string, metadata?: object) => prisma.auditLog.create({ data: { actorUserId, action, entityType, entityId, metadata: metadata as any } });
const notify = (userId:string,title:string,body:string,type:string) => prisma.notification.create({data:{userId,title,body,type}});

app.get('/api/health', (_req,res) => res.json({status:'ok', service:'JUZARA Health API'}));
app.post('/api/auth/register', authLimiter, asyncRoute(async (req,res) => {
  const schema = z.object({
    fullName:z.string().trim().min(3).max(120),
    username:z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9._-]+$/).optional(),
    email:z.string().trim().email().max(254),
    phone:z.string().trim().regex(/^\\+?[0-9]{8,15}$/,'Nomor telepon harus 8–15 digit dan boleh diawali +'),
    password:z.string().min(10).max(128),
    identityNumber:z.string().trim().min(8).max(32),
    birthDate:z.string().date(),
    gender:z.enum(['Laki-laki','Perempuan']),
    address:z.string().trim().min(8).max(500)
  });
  const data = schema.parse(req.body);
  const passwordHash = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({ data:{
    email:data.email.toLowerCase(), username:data.username?.toLowerCase(), phone:data.phone,
    passwordHash, role:Role.PATIENT,
    patient:{create:{fullName:data.fullName, identityNumber:data.identityNumber, birthDate:new Date(data.birthDate), gender:data.gender, address:data.address}}
  }, select:{id:true,email:true,username:true,role:true} });
  await audit(user.id,'PATIENT_REGISTERED','User',user.id); res.status(201).json({message:'Registrasi berhasil. Verifikasi akun perlu dikonfigurasi sebelum layanan produksi.',user});
}));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req,res) => {
  const data = z.object({identifier:z.string().trim().min(1),password:z.string().min(1),portal:z.enum(['patient','doctor','admin']).default('patient')}).parse(req.body);
  const identifier=data.identifier.toLowerCase();
  const user = await prisma.user.findFirst({where:{OR:[{email:identifier},{username:identifier}]},include:{doctor:true,patient:true}});
  const valid = user && await bcrypt.compare(data.password,user.passwordHash);
  const allowed = data.portal==='patient' ? user?.role===Role.PATIENT : data.portal==='doctor' ? user?.role===Role.DOCTOR && !!user.doctor?.verifiedAt : user?.role===Role.ADMIN;
  if (!valid || !allowed) return res.status(401).json({error:'Email, password, atau hak akses tidak sesuai.'});
  req.session.userId=user!.id; req.session.role=user!.role; await audit(user!.id,'LOGIN','User',user!.id);
  res.json({user:{id:user!.id,email:user!.email,role:user!.role,profile:user!.patient || user!.doctor}});
}));
app.post('/api/auth/logout', requireAuth, asyncRoute(async(req,res)=>{ await audit(req.session.userId,'LOGOUT','User',req.session.userId); req.session.destroy(()=>res.json({message:'Anda telah logout.'})); }));
app.get('/api/auth/me', requireAuth, asyncRoute(async(req,res)=>{ const raw=await prisma.user.findUnique({where:{id:req.session.userId},include:{patient:true,doctor:true}}); const user=raw ? {id:raw.id,email:raw.email,username:raw.username,role:raw.role,patient:raw.patient,doctor:raw.doctor,profile:raw.patient || raw.doctor} : null; res.json({user}); }));
app.get('/api/facilities', asyncRoute(async(req,res)=>{ const q=String(req.query.q||''); const type=String(req.query.type||''); const rows=await prisma.healthcareFacility.findMany({where:{name:{contains:q,mode:'insensitive'},...(type?{type}:{})},include:{services:true},take:50,orderBy:{name:'asc'}}); res.json({facilities:rows}); }));
app.get('/api/doctors', asyncRoute(async(req,res)=>{ const doctors=await prisma.doctor.findMany({where:{verifiedAt:{not:null}},include:{facilities:{include:{facility:true}}},orderBy:{displayName:'asc'}}); res.json({doctors}); }));
app.get('/api/schedules', asyncRoute(async(req,res)=>{ const date=String(req.query.date||''); const d=date?new Date(`${date}T00:00:00+08:00`):new Date(); const schedules=await prisma.doctorSchedule.findMany({where:{isActive:true,weekday:d.getDay(),...(req.query.facilityId?{facilityId:String(req.query.facilityId)}:{}),...(req.query.doctorId?{doctorId:String(req.query.doctorId)}:{})},include:{doctor:true,facility:true}}); res.json({schedules}); }));
app.post('/api/appointments', requireAuth, requireRole(Role.PATIENT), asyncRoute(async(req,res)=>{
  const data=z.object({doctorId:z.string(),facilityId:z.string(),scheduleId:z.string(),serviceDate:z.string(),slotTime:z.string(),mainComplaint:z.string().min(3),symptoms:z.string().optional(),duration:z.string().optional(),notes:z.string().optional()}).parse(req.body);
  const patient=await prisma.patientProfile.findUnique({where:{userId:req.session.userId}}); if(!patient) return res.status(400).json({error:'Profil pasien belum lengkap.'});
  const date=new Date(`${data.serviceDate}T00:00:00+08:00`); if(Number.isNaN(date.getTime())) return res.status(400).json({error:'Tanggal tidak valid.'});
  const result=await prisma.$transaction(async(tx)=>{
    const schedule=await tx.doctorSchedule.findFirst({where:{id:data.scheduleId,doctorId:data.doctorId,facilityId:data.facilityId,isActive:true}}); if(!schedule) throw new Error('Jadwal tidak tersedia.');
    const booked=await tx.appointment.count({where:{doctorId:data.doctorId,facilityId:data.facilityId,serviceDate:date,status:'BOOKED'}}); if(booked>=schedule.quota) throw new Error('Kuota dokter sudah penuh.');
    const slotTaken=await tx.appointment.findFirst({where:{doctorId:data.doctorId,facilityId:data.facilityId,serviceDate:date,slotTime:data.slotTime,status:'BOOKED'}}); if(slotTaken) throw new Error('Slot ini sudah dipesan. Silakan pilih slot lain.');
    const max=await tx.appointment.aggregate({where:{doctorId:data.doctorId,facilityId:data.facilityId,serviceDate:date},_max:{queueNumber:true}}); const queueNumber=(max._max.queueNumber||0)+1;
    const bookingCode=`JZ-${date.toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const appointment=await tx.appointment.create({data:{bookingCode,patientId:patient.id,doctorId:data.doctorId,facilityId:data.facilityId,scheduleId:data.scheduleId,serviceDate:date,slotTime:data.slotTime,queueNumber,complaint:{create:{patientId:patient.id,mainComplaint:data.mainComplaint,symptoms:data.symptoms,duration:data.duration,notes:data.notes}},queue:{create:{queueNumber,status:'WAITING',estimatedMinutes:Math.max(0,queueNumber-1)*schedule.slotMinutes}},consultation:{create:{patientId:patient.id,status:'WAITING'}}},include:{doctor:true,facility:true,queue:true}});
    await tx.auditLog.create({data:{actorUserId:req.session.userId,action:'APPOINTMENT_CREATED',entityType:'Appointment',entityId:appointment.id}}); await tx.notification.create({data:{userId:req.session.userId!,title:'Reservasi berhasil',body:`Booking ${bookingCode} berhasil dibuat.`,type:'APPOINTMENT'}}); return appointment;
  },{isolationLevel:'Serializable'});
  res.status(201).json({appointment:result});
}));
app.get('/api/appointments/mine', requireAuth, requireRole(Role.PATIENT), asyncRoute(async(req,res)=>{ const patient=await prisma.patientProfile.findUnique({where:{userId:req.session.userId}}); const appointments=patient?await prisma.appointment.findMany({where:{patientId:patient.id},include:{doctor:true,facility:true,queue:true,complaint:true},orderBy:{serviceDate:'desc'}}):[]; res.json({appointments}); }));
app.patch('/api/queues/:id/status', requireAuth, requireRole(Role.DOCTOR,Role.ADMIN), asyncRoute(async(req,res)=>{ const status=z.enum(['WAITING','IN_SERVICE','COMPLETED','CANCELLED','NO_SHOW']).parse(req.body.status); const doctor=req.session.role===Role.DOCTOR?await prisma.doctor.findUnique({where:{userId:req.session.userId}}):null; const existing=await prisma.queue.findUnique({where:{id:req.params.id},include:{appointment:true}}); if(!existing) return res.status(404).json({error:'Antrean tidak ditemukan.'}); if(req.session.role===Role.DOCTOR&&(!doctor?.verifiedAt||existing.appointment.doctorId!==doctor.id)) return res.status(403).json({error:'Antrean ini bukan kewenangan Anda.'}); const queue=await prisma.queue.update({where:{id:req.params.id},data:{status,calledAt:status==='IN_SERVICE'?new Date():undefined,completedAt:status==='COMPLETED'?new Date():undefined}}); await audit(req.session.userId,'QUEUE_STATUS_CHANGED','Queue',queue.id,{status}); const appointment=await prisma.appointment.findUnique({where:{id:existing.appointmentId},include:{patient:true}}); if(appointment) await notify((await prisma.patientProfile.findUnique({where:{id:appointment.patientId}}))!.userId,'Pembaruan antrean',`Status antrean Anda berubah menjadi ${status}.`,'QUEUE'); res.json({queue}); }));
// Doctor portal: every endpoint is restricted server-side to a verified doctor.
app.post('/api/admin/doctors', requireAuth, requireRole(Role.ADMIN), asyncRoute(async(req,res)=>{
 const data=z.object({email:z.string().email(),password:z.string().min(12),displayName:z.string().min(3),specialty:z.string().min(3),licenseNumber:z.string().min(5),facilityId:z.string().optional(),weekday:z.number().int().min(0).max(6).optional(),startTime:z.string().optional(),endTime:z.string().optional(),quota:z.number().int().positive().optional()}).parse(req.body); const hash=await bcrypt.hash(data.password,12);
 const user=await prisma.user.create({data:{email:data.email.toLowerCase(),passwordHash:hash,role:Role.DOCTOR,isVerified:true,doctor:{create:{displayName:data.displayName,specialty:data.specialty,licenseNumber:data.licenseNumber,verifiedAt:new Date()}}},include:{doctor:true},select:{id:true,email:true,role:true,doctor:true}}); if(data.facilityId){await prisma.doctorFacility.create({data:{doctorId:user.doctor!.id,facilityId:data.facilityId}}); if(data.weekday!==undefined&&data.startTime&&data.endTime&&data.quota){await prisma.doctorSchedule.create({data:{doctorId:user.doctor!.id,facilityId:data.facilityId,weekday:data.weekday,startTime:data.startTime,endTime:data.endTime,quota:data.quota,isActive:true}});}} await audit(req.session.userId,'DOCTOR_ACCOUNT_PROVISIONED','User',user.id); res.status(201).json({user,message:'Akun dokter dibuat dan diverifikasi oleh admin.'});
}));
app.get('/api/doctor/dashboard', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId},include:{facilities:{include:{facility:true}}}});
 if(!doctor?.verifiedAt) return res.status(403).json({error:'Akun dokter belum diverifikasi.'});
 const today=new Date(); const start=new Date(today); start.setHours(0,0,0,0); const end=new Date(today); end.setHours(23,59,59,999);
 const appointments=await prisma.appointment.findMany({where:{doctorId:doctor.id,serviceDate:{gte:start,lte:end},status:'BOOKED'},include:{patient:true,facility:true,queue:true,complaint:true,consultation:true},orderBy:{slotTime:'asc'}});
 const schedules=await prisma.doctorSchedule.findMany({where:{doctorId:doctor.id,isActive:true},include:{facility:true},orderBy:{weekday:'asc'}});
 res.json({doctor,appointments,schedules,stats:{today:appointments.length,waiting:appointments.filter(a=>a.queue?.status==='WAITING').length,inService:appointments.filter(a=>a.queue?.status==='IN_SERVICE').length}});
}));
app.get('/api/doctor/appointments', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId}}); if(!doctor?.verifiedAt) return res.status(403).json({error:'Akun dokter belum diverifikasi.'});
 const appointments=await prisma.appointment.findMany({where:{doctorId:doctor.id,...(req.query.date?{serviceDate:new Date(`${String(req.query.date)}T00:00:00+08:00`)}:{})},include:{patient:true,facility:true,queue:true,complaint:true,consultation:true},orderBy:[{serviceDate:'desc'},{slotTime:'asc'}],take:100}); res.json({appointments});
}));
app.get('/api/consultations/mine', requireAuth, requireRole(Role.PATIENT), asyncRoute(async(req,res)=>{const p=await prisma.patientProfile.findUnique({where:{userId:req.session.userId}});const consultations=p?await prisma.consultation.findMany({where:{patientId:p.id},include:{appointment:{include:{doctor:true,facility:true,complaint:true}},messages:{orderBy:{createdAt:'asc'}},record:true},orderBy:{updatedAt:'desc'}}):[];res.json({consultations});}));
app.get('/api/doctor/consultations', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId}}); if(!doctor?.verifiedAt) return res.status(403).json({error:'Akun dokter belum diverifikasi.'});
 const rows=await prisma.consultation.findMany({where:{appointment:{doctorId:doctor.id}},include:{patient:true,appointment:{include:{facility:true,complaint:true,queue:true}},messages:{orderBy:{createdAt:'asc'}},record:true},orderBy:{updatedAt:'desc'},take:100}); res.json({consultations:rows});
}));
app.post('/api/consultations/:id/messages', requireAuth, asyncRoute(async(req,res)=>{
 const body=z.object({body:z.string().min(1).max(4000)}).parse(req.body); const c=await prisma.consultation.findUnique({where:{id:req.params.id},include:{appointment:{include:{patient:true,doctor:{include:{user:true}}}}}}); if(!c) return res.status(404).json({error:'Konsultasi tidak ditemukan.'});
 const isPatient=c.patient.userId===req.session.userId; const isDoctor=c.appointment.doctor.userId===req.session.userId && !!c.appointment.doctor.verifiedAt; if(!isPatient&&!isDoctor) return res.status(403).json({error:'Tidak berwenang membuka konsultasi ini.'});
 const message=await prisma.consultationMessage.create({data:{consultationId:c.id,senderUserId:req.session.userId!,body:body.body}}); const recipient=isPatient?c.appointment.doctor.userId:c.patient.userId; await notify(recipient,'Pesan konsultasi baru','Ada pesan baru dalam ruang konsultasi JUZARA.','CONSULTATION'); res.status(201).json({message});
}));
app.post('/api/doctor/consultations/:id/start', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId}}); const c=await prisma.consultation.findFirst({where:{id:req.params.id,appointment:{doctorId:doctor?.id}}}); if(!c||!doctor?.verifiedAt) return res.status(404).json({error:'Konsultasi tidak ditemukan atau tidak berwenang.'}); const updated=await prisma.consultation.update({where:{id:c.id},data:{status:'IN_PROGRESS',startedAt:new Date()}}); await audit(req.session.userId,'CONSULTATION_STARTED','Consultation',c.id); res.json({consultation:updated});
}));
app.put('/api/doctor/consultations/:id/record', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const data=z.object({subjective:z.string().optional(),assessment:z.string().optional(),plan:z.string().optional(),advice:z.string().optional()}).parse(req.body); const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId}}); const c=await prisma.consultation.findFirst({where:{id:req.params.id,appointment:{doctorId:doctor?.id}}}); if(!c||!doctor?.verifiedAt) return res.status(404).json({error:'Konsultasi tidak ditemukan atau tidak berwenang.'}); const record=await prisma.consultationRecord.upsert({where:{consultationId:c.id},create:{consultationId:c.id,...data},update:data}); await audit(req.session.userId,'CONSULTATION_RECORD_UPDATED','ConsultationRecord',record.id); res.json({record});
}));
app.post('/api/doctor/consultations/:id/complete', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{
 const doctor=await prisma.doctor.findUnique({where:{userId:req.session.userId}}); const c=await prisma.consultation.findFirst({where:{id:req.params.id,appointment:{doctorId:doctor?.id},status:{not:'CANCELLED'}}}); if(!c||!doctor?.verifiedAt) return res.status(404).json({error:'Konsultasi tidak ditemukan atau tidak berwenang.'}); const updated=await prisma.consultation.update({where:{id:c.id},data:{status:'COMPLETED',endedAt:new Date()}}); await notify(c.patientId? (await prisma.patientProfile.findUnique({where:{id:c.patientId}}))!.userId:'','Konsultasi selesai','Catatan konsultasi telah diperbarui.','CONSULTATION'); await audit(req.session.userId,'CONSULTATION_COMPLETED','Consultation',c.id); res.json({consultation:updated});
}));
app.get('/api/laboratory/mine', requireAuth, requireRole(Role.PATIENT), asyncRoute(async(req,res)=>{const p=await prisma.patientProfile.findUnique({where:{userId:req.session.userId}});const results=p?await prisma.laboratoryResult.findMany({where:{patientId:p.id,validatedAt:{not:null}},orderBy:{createdAt:'desc'}}):[];res.json({results});}));
app.get('/api/doctor/laboratory/:patientId', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{const d=await prisma.doctor.findUnique({where:{userId:req.session.userId}});if(!d?.verifiedAt)return res.status(403).json({error:'Akun dokter belum diverifikasi.'});const linked=await prisma.appointment.findFirst({where:{doctorId:d.id,patientId:req.params.patientId}});if(!linked)return res.status(403).json({error:'Pasien tidak berada dalam cakupan pelayanan Anda.'});const results=await prisma.laboratoryResult.findMany({where:{patientId:req.params.patientId},orderBy:{createdAt:'desc'}});res.json({results});}));
app.post('/api/doctor/laboratory', requireAuth, requireRole(Role.DOCTOR), asyncRoute(async(req,res)=>{const data=z.object({patientId:z.string(),testName:z.string().min(2),category:z.string().min(2),resultValue:z.string().min(1),unit:z.string().optional(),referenceRange:z.string().optional(),interpretation:z.string().optional(),sourceReference:z.string().min(3)}).parse(req.body);const d=await prisma.doctor.findUnique({where:{userId:req.session.userId}});if(!d?.verifiedAt)return res.status(403).json({error:'Akun dokter belum diverifikasi.'});const linked=await prisma.appointment.findFirst({where:{doctorId:d.id,patientId:data.patientId}});if(!linked)return res.status(403).json({error:'Pasien tidak berada dalam cakupan pelayanan Anda.'});const result=await prisma.laboratoryResult.create({data:{...data,validatedByUserId:req.session.userId,validatedAt:new Date(),isDemo:false}});await audit(req.session.userId,'LAB_RESULT_CREATED','LaboratoryResult',result.id);const patient=await prisma.patientProfile.findUnique({where:{id:data.patientId}});if(patient)await notify(patient.userId,'Hasil pemeriksaan tersedia','Dokter telah menerbitkan hasil pemeriksaan Anda.','LAB');res.status(201).json({result});}));
app.get('/api/notifications', requireAuth, asyncRoute(async(req,res)=>{const items=await prisma.notification.findMany({where:{userId:req.session.userId},orderBy:{createdAt:'desc'},take:50});res.json({notifications:items});}));
app.patch('/api/notifications/:id/read', requireAuth, asyncRoute(async(req,res)=>{const n=await prisma.notification.updateMany({where:{id:req.params.id,userId:req.session.userId},data:{readAt:new Date()}});res.json({updated:n.count});}));
app.patch('/api/notifications/read-all', requireAuth, asyncRoute(async(req,res)=>{const n=await prisma.notification.updateMany({where:{userId:req.session.userId,readAt:null},data:{readAt:new Date()}});res.json({updated:n.count});}));
app.get('/api/articles', asyncRoute(async(_req,res)=>{ const articles=await prisma.healthArticle.findMany({where:{isPublished:true},orderBy:{publishedAt:'desc'}}); res.json({articles}); }));
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{ if(err instanceof z.ZodError) return res.status(400).json({error:'Data tidak valid.',details:err.issues}); if(err?.code==='P2002') return res.status(409).json({error:'Data duplikat atau slot baru saja dipesan.'}); console.error(err); res.status(400).json({error:err.message||'Terjadi kesalahan.'}); });
const port=Number(process.env.PORT||4000); app.listen(port,()=>console.log(`JUZARA API running on http://localhost:${port}`));
