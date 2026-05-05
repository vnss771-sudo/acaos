import type { Request } from 'express'

export type AuthUser = {
  id: string
  email: string
  name: string | null
}

export type AuthedRequest = Request & {
  user: AuthUser
}
