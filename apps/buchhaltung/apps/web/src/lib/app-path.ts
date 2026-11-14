/** Ein lokaler Anwendungspfad unter dem beim Build festgelegten Vite-Basispfad. */
export function prefixAppPath(base: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Anwendungspfad muss mit genau einem / beginnen");
  return `${base.replace(/\/$/, "")}${path}`;
}

export function appPath(path: string): string {
  return prefixAppPath(import.meta.env.BASE_URL, path);
}
