import { z } from 'zod'

const ServerSessionSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string(),
    name: z.string(),
    role: z.string().nullable().optional(),
  }),
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
  }),
})

export async function readServerSession(response: Response) {
  if (!response.ok) return { user: null, session: null }
  const parsed = ServerSessionSchema.safeParse(await response.json())
  if (!parsed.success || parsed.data.user.id !== parsed.data.session.userId) {
    return { user: null, session: null }
  }
  return parsed.data
}
