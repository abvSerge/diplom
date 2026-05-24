const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER || "admin",
  host: process.env.DB_HOST || "postgres",
  database: process.env.DB_NAME || "app",
  password: process.env.DB_PASSWORD || "admin",
  port: parseInt(process.env.DB_PORT) || 5432,

  max: parseInt(process.env.DB_POOL_SIZE) || 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  console.error("[DB] Неожиданная ошибка idle-клиента:", err);
});

pool.on("connect", () => {
  console.log(`[DB] Новое соединение (всего активно: ${pool.totalCount})`);
});

module.exports = pool;
