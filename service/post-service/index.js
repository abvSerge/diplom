const express = require("express");
const Joi = require("joi");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const pool = require("./db");
const redis = require("./redis");

const app = express();
app.use(express.json());
const faultInjection = require("./fault-injection");
app.use(faultInjection);
//Swagger конфигурация
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Post Service API",
      version: "1.0.0",
      description: "API для управления постами (CRUD) с кешированием в Redis",
    },
    servers: [
      {
        url: "http://localhost:3003",
        description: "Post service (прямой доступ)",
      },
      {
        url: "http://localhost:3000/api",
        description: "Через API Gateway",
      },
    ],
    components: {
      schemas: {
        Post: {
          type: "object",
          properties: {
            id: { type: "integer", example: 1 },
            title: { type: "string", example: "Мой пост" },
            content: { type: "string", example: "Содержимое поста" },
            user_id: { type: "integer", example: 1 },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Internal server error" },
          },
        },
      },
    },
  },
  apis: ["./index.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const postSchema = Joi.object({
  title: Joi.string().min(1).max(200).required(),
  content: Joi.string().min(1).required(),
  user_id: Joi.number().integer().positive().required(),
});

const updatePostSchema = Joi.object({
  title: Joi.string().min(1).max(200),
  content: Joi.string().min(1),
  user_id: Joi.number().integer().positive(),
}).min(1);

//Эндпоинты

/**
 * @swagger
 * /posts:
 *   get:
 *     summary: Возвращает список постов
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Максимальное количество записей (по умолчанию 20)
 *     responses:
 *       200:
 *         description: Успешный ответ
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Post'
 *       500:
 *         description: Ошибка сервера
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get("/posts", async (req, res) => {
  try {
    let limit = parseInt(req.query.limit);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const cacheKey = `posts:limit:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query(
      "SELECT * FROM posts ORDER BY id DESC LIMIT $1",
      [limit],
    );

    await redis.set(cacheKey, JSON.stringify(result.rows), { EX: 30 });
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
/**
 * @swagger
 * /posts/cursor:
 *   get:
 *     summary: Курсорная пагинация постов (быстрее на больших объёмах)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Количество записей на страницу (по умолчанию 20)
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: integer
 *         description: ID последнего поста с предыдущей страницы (для получения следующей)
 *     responses:
 *       200:
 *         description: Успешный ответ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *                 nextCursor:
 *                   type: integer
 *                   nullable: true
 */
app.get("/posts/cursor", async (req, res) => {
  try {
    let limit = parseInt(req.query.limit);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;

    let sql = "SELECT * FROM posts";
    const params = [];
    if (cursor && !isNaN(cursor)) {
      sql += " WHERE id < $1";
      params.push(cursor);
    }
    sql += " ORDER BY id DESC LIMIT $" + (params.length + 1);
    params.push(limit);

    const result = await pool.query(sql, params);

    let nextCursor = null;
    if (result.rows.length === limit) {
      nextCursor = result.rows[result.rows.length - 1].id;
    }

    res.json({
      data: result.rows,
      nextCursor: nextCursor,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /posts/offset:
 *   get:
 *     summary: Временный эндпоинт для сравнения OFFSET (медленно на больших страницах)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Количество записей (по умолчанию 20)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Сколько записей пропустить (по умолчанию 0)
 *     responses:
 *       200:
 *         description: Массив постов
 */
app.get("/posts/offset", async (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 20;
    if (limit > 100) limit = 100;
    let offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      "SELECT * FROM posts ORDER BY id DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /posts/{id}:
 *   get:
 *     summary: Получить один пост по ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID поста
 *     responses:
 *       200:
 *         description: Успешный ответ
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Неверный ID
 *       404:
 *         description: Пост не найден
 *       500:
 *         description: Ошибка сервера
 */
app.get("/posts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid post ID" });
    }

    const cacheKey = `post:${id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query("SELECT * FROM posts WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    await redis.set(cacheKey, JSON.stringify(result.rows[0]), { EX: 60 });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /posts:
 *   post:
 *     summary: Создать новый пост
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - content
 *               - user_id
 *             properties:
 *               title:
 *                 type: string
 *                 example: "Новый пост"
 *               content:
 *                 type: string
 *                 example: "Содержимое поста"
 *               user_id:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       201:
 *         description: Пост создан
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Ошибка валидации
 *       500:
 *         description: Ошибка сервера
 */
app.post("/posts", async (req, res) => {
  try {
    const { error, value } = postSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { title, content, user_id } = value;
    const result = await pool.query(
      "INSERT INTO posts (title, content, user_id) VALUES ($1, $2, $3) RETURNING *",
      [title, content, user_id],
    );

    const keys = await redis.keys("posts:limit:*");
    if (keys.length) await redis.del(keys);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /posts/{id}:
 *   put:
 *     summary: Обновить пост
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID поста
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               content:
 *                 type: string
 *               user_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Пост обновлён
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Неверный ID или ошибка валидации
 *       404:
 *         description: Пост не найден
 *       500:
 *         description: Ошибка сервера
 */
app.put("/posts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid post ID" });
    }

    const { error, value } = updatePostSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const check = await pool.query("SELECT id FROM posts WHERE id = $1", [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(value)) {
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
    values.push(id);
    const query = `UPDATE posts SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(query, values);

    await redis.del(`post:${id}`);
    const keys = await redis.keys("posts:limit:*");
    if (keys.length) await redis.del(keys);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /posts/{id}:
 *   delete:
 *     summary: Удалить пост
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID поста
 *     responses:
 *       204:
 *         description: Пост удалён (нет содержимого)
 *       400:
 *         description: Неверный ID
 *       404:
 *         description: Пост не найден
 *       500:
 *         description: Ошибка сервера
 */
app.delete("/posts/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid post ID" });
    }

    const result = await pool.query(
      "DELETE FROM posts WHERE id = $1 RETURNING id",
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    await redis.del(`post:${id}`);
    const keys = await redis.keys("posts:limit:*");
    if (keys.length) await redis.del(keys);

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`Post service listening on port ${PORT}`);
});

module.exports = app;
