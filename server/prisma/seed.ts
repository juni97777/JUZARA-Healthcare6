import bcrypt from 'bcryptjs';
import { PrismaClient, Role } from '@prisma/client';
const prisma = new PrismaClient();
async function main(){
  if(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD){
    const passwordHash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
    await prisma.user.upsert({where:{email:process.env.ADMIN_EMAIL.toLowerCase()},update:{passwordHash,role:Role.ADMIN,isVerified:true},create:{email:process.env.ADMIN_EMAIL.toLowerCase(),passwordHash,role:Role.ADMIN,isVerified:true}});
    console.log('Admin bootstrap dibuat dari environment.');
  }
  const facility = await prisma.healthcareFacility.upsert({
    where:{id:'demo-facility-juzara'},
    update:{},
    create:{id:'demo-facility-juzara',name:'Fasilitas Kesehatan Demo',type:'Klinik',address:'Alamat belum diverifikasi — data demonstrasi',region:'Makassar, Sulawesi Selatan',phone:null,openingHours:'Data operasional belum dikonfirmasi',isDemo:true,services:{create:[{name:'Konsultasi umum',description:'Layanan contoh untuk pengujian aplikasi'},{name:'Pemeriksaan dasar',description:'Layanan contoh; bukan layanan nyata'}]}}
  });
  const names=[['dr. Zaskiya Dwi Anugrah','Dokter umum'],['drg. Bayu Liburaya','Dokter gigi'],['dr. Juniar Rahman Sp.DP','Spesialis penyakit dalam'],['dr. Muhammad Zidan Sp.A','Spesialis anak'],['dr. Zahra Nur Habibah Sp.OG','Spesialis kandungan']];
  for(const [i,[displayName,specialty]] of names.entries()){
    const email=`doctor-demo-${i+1}@juzara.invalid`;
    const user=await prisma.user.upsert({where:{email},update:{},create:{email,passwordHash:'!DISABLED_DEMO_ACCOUNT!',role:Role.DOCTOR,isVerified:false}});
    const doctor=await prisma.doctor.upsert({where:{userId:user.id},update:{},create:{userId:user.id,displayName,specialty,verifiedAt:null}});
    await prisma.doctorFacility.upsert({where:{doctorId_facilityId:{doctorId:doctor.id,facilityId:facility.id}},update:{},create:{doctorId:doctor.id,facilityId:facility.id}});
    await prisma.doctorSchedule.upsert({where:{id:`demo-schedule-${i+1}`},update:{},create:{id:`demo-schedule-${i+1}`,doctorId:doctor.id,facilityId:facility.id,weekday:i+1,startTime:['08:00','13:00','10:00','08:00','13:00'][i],endTime:['12:00','17:00','15:00','12:00','17:00'][i],quota:20,slotMinutes:20,isActive:true,note:'Jadwal contoh; wajib diverifikasi oleh fasilitas kesehatan'}});
  }
  console.log('Seed demo selesai:',facility.name,'— semua data fasilitas/jadwal berstatus demonstrasi.');
}
main().finally(()=>prisma.$disconnect());
