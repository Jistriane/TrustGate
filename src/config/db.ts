export interface DbConfig {
  databaseUrl: string;
}

export function loadDbConfig(): DbConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }
  return { databaseUrl };
}

