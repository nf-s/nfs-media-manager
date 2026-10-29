'use client'

import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useAuthClient } from '@/hooks/useAuthClient'

export default function LoginForm() {
  const router = useRouter()
  const authClient = useAuthClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await authClient.signIn.email({
        email,
        password,
      })

      if (response.error) {
        throw response.error
      }
    },
    onSuccess: async () => {
      router.replace('/albums')
      router.refresh()
    },
  })

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        loginMutation.mutate()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={loginMutation.isPending || email.length === 0 || password.length === 0}
      >
        {loginMutation.isPending ? 'Signing in...' : 'Sign In'}
      </Button>
    </form>
  )
}
