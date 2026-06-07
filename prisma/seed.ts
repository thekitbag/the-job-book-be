import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const PILOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const PILOT_JOB_ID = '00000000-0000-0000-0000-000000000002'

async function main() {
  const mike = await prisma.user.upsert({
    where: { id: PILOT_USER_ID },
    update: {},
    create: {
      id: PILOT_USER_ID,
      email: 'mike@pilot.thejobbook.local',
      name: 'Mike',
      role: 'PILOT',
    },
  })

  const job = await prisma.job.upsert({
    where: { id: PILOT_JOB_ID },
    update: {},
    create: {
      id: PILOT_JOB_ID,
      ownerUserId: mike.id,
      title: 'Garden Room Build',
      jobType: 'construction',
      status: 'ACTIVE',
      roughLocationOrLabel: 'Back garden, Oakfield Road',
    },
  })

  console.log('Seeded pilot user:', mike.id)
  console.log('Seeded active job:', job.id)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
