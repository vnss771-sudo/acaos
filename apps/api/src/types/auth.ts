import type { Request } from 'express'

export type AuthUser = {
  id: string
  email: string
  name: string | null
  emailVerified: boolean
}

export type AuthedRequest = Request & {
  user: AuthUser
}
