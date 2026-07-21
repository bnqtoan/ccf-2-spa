import { Hono } from 'hono'
import { registerRoutes } from './routes/index'

const app = new Hono()

registerRoutes(app)

export default app
