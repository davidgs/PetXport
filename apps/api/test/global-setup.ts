export default async function setup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(() => undefined);
}
