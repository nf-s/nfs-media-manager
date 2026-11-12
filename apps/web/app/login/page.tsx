import LoginForm from '@/components/login-form'

export default function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-panel">
        <h1>Sign in</h1>
        <div className="login-form">
          <LoginForm />
        </div>
      </div>
    </div>
  )
}
