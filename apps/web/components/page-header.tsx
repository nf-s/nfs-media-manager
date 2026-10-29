export default function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string
  title: string
  description?: string
}) {
  return (
    <div className="px-0 py-1">
      {eyebrow ? (
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
          {eyebrow}
        </div>
      ) : null}
      <h1
        className={eyebrow ? 'mt-1 text-2xl font-semibold text-[hsl(var(--foreground))]' : 'text-2xl font-semibold text-[hsl(var(--foreground))]'}
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-2 max-w-4xl text-sm leading-5 text-[hsl(var(--muted-foreground))]">
          {description}
        </p>
      ) : null}
    </div>
  )
}
