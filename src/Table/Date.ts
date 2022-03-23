export function timeToDateString(time: number) {
  const ye = new Intl.DateTimeFormat("en", { year: "numeric" });
  const mo = new Intl.DateTimeFormat("en", { month: "2-digit" });
  const da = new Intl.DateTimeFormat("en", { day: "2-digit" });

  const date = new Date(time);
  return `${ye.format(date)}/${mo.format(date)}/${da.format(date)}`;
}
