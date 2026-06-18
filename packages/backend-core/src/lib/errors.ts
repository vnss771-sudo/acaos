// Framework-agnostic application error carrying an HTTP status code. Lives in
// backend-core so shared services can throw it without depending on the API's
// Express layer; apps/api/src/lib/http.ts re-exports it as ApiError and maps it
// to a response in the Express error handler.
export class ApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}
