import { buildApp } from './app.js'

const host = process.env.HOST ?? '0.0.0.0'
const port = Number(process.env.PORT ?? 3000)

const app = buildApp()

app.listen({ host, port }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
