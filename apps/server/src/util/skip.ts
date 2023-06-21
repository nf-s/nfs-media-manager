export function skip(key: string) {
  return (process.env.SKIP?.split(",") ?? []).includes(key);
}
