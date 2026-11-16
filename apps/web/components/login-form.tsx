'use client'

import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { Notice } from '@repo/ui/components/ds/feedback'
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
      className="sec-stack"
      onSubmit={(event) => {
        event.preventDefault()
        loginMutation.mutate()
      }}
    >
      <div className="ds-field">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          controlSize="md"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </div>

      <div className="ds-field">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          controlSize="md"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {loginMutation.isError && (
        <Notice tone="danger">
          Could not sign in. Check the email and password.
        </Notice>
      )}

      <Button
        size="md"
        variant="primary"
        type="submit"
        disabled={
          loginMutation.isPending || email.length === 0 || password.length === 0
        }
      >
        {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  )
}
