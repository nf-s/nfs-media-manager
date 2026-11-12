// The adapter generates this module after Next's typecheck has completed.
declare module '*.open-next/worker.js' {
  const handler: {
    fetch(
      request: Request,
      env: CloudflareEnv,
      context: ExecutionContext,
    ): Promise<Response>
  }
  export default handler
}
