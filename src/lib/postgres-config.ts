type Environment = Readonly<Record<string, string | undefined>>;

// This pilot connects only to the dedicated local cluster, using its restricted role.
export function postgresConfiguration(env: Environment): { connectionString: string; password: string } {
  try {
    const url = new URL(env.IFD_DATABASE_URL ?? "");
    const password = decodeURIComponent(url.password);
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "55432" ||
      url.pathname !== "/ifd_live" || url.username !== "ifd_app" || password.length < 32 || url.search || url.hash) throw Error();
    return { connectionString: url.href, password };
  } catch { throw Error("Invalid local Postgres configuration"); }
}
