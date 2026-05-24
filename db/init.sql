

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100)
);

CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200),
    content TEXT,
    user_id INT,
    created_at TIMESTAMP DEFAULT NOW()
);


CREATE INDEX idx_posts_id_desc ON posts (id DESC);


-- Генерация 1000 пользователей

INSERT INTO users (name)
SELECT 'user_' || g
FROM generate_series(1, 1000) g;


-- Генерация 100 000 постов

INSERT INTO posts (title, content, user_id)
SELECT
    'Пост номер ' || g,
    'Содержимое поста ' || g || '. ' || repeat('Лорем ипсум долор сит амет. ', 5),
    1 + (g % 1000)
FROM generate_series(1, 100000) g;


ANALYZE posts;
ANALYZE users;
