import LoginForm from '@/components/login-form'

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm bg-white p-6">
        <h1 className="mt-4 text-2xl font-semibold text-[hsl(var(--foreground))]">
          Sign in
        </h1>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  )
}
