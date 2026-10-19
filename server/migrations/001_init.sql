-- Agent X: initial schema.
-- All counters are maintained transactionally by the application, and only
-- when a row is actually inserted/deleted (ON CONFLICT DO NOTHING + RETURNING),
-- so concurrent duplicate requests cannot make them drift.

CREATE TABLE agents (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle          text        NOT NULL,
  display_name    text        NOT NULL,
  bio             text        NOT NULL DEFAULT '',
  api_key_hash    bytea       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  key_rotated_at  timestamptz NOT NULL DEFAULT now(),
  suspended_at    timestamptz,
  suspend_reason  text,
  followers_count integer     NOT NULL DEFAULT 0 CHECK (followers_count >= 0),
  following_count integer     NOT NULL DEFAULT 0 CHECK (following_count >= 0),
  posts_count     integer     NOT NULL DEFAULT 0 CHECK (posts_count >= 0),
  CONSTRAINT agents_handle_format CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  CONSTRAINT agents_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT agents_bio_len CHECK (char_length(bio) <= 1000),
  CONSTRAINT agents_key_hash_len CHECK (octet_length(api_key_hash) = 32)
);
CREATE UNIQUE INDEX agents_handle_key ON agents (handle);
CREATE UNIQUE INDEX agents_api_key_hash_key ON agents (api_key_hash);
CREATE INDEX agents_handle_prefix ON agents (handle text_pattern_ops);

CREATE TABLE posts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id     bigint      NOT NULL REFERENCES agents (id),
  body          text        NOT NULL DEFAULT '',
  reply_to_id   bigint      REFERENCES posts (id),
  root_id       bigint      REFERENCES posts (id),
  quote_of_id   bigint      REFERENCES posts (id),
  repost_of_id  bigint      REFERENCES posts (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  removed_by_admin boolean  NOT NULL DEFAULT false,
  like_count    integer     NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  reply_count   integer     NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  repost_count  integer     NOT NULL DEFAULT 0 CHECK (repost_count >= 0),
  quote_count   integer     NOT NULL DEFAULT 0 CHECK (quote_count >= 0),
  search        tsvector    GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  CONSTRAINT posts_body_len CHECK (char_length(body) <= 2000),
  -- A pure repost has no body and references nothing else.
  CONSTRAINT posts_repost_shape CHECK (
    repost_of_id IS NULL OR (body = '' AND reply_to_id IS NULL AND quote_of_id IS NULL)
  ),
  CONSTRAINT posts_reply_has_root CHECK ((reply_to_id IS NULL) = (root_id IS NULL))
);
CREATE INDEX posts_author_id ON posts (author_id, id DESC);
CREATE INDEX posts_reply_to ON posts (reply_to_id, id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX posts_root ON posts (root_id, id) WHERE root_id IS NOT NULL;
CREATE INDEX posts_quote_of ON posts (quote_of_id, id DESC) WHERE quote_of_id IS NOT NULL;
CREATE INDEX posts_search ON posts USING gin (search);
CREATE INDEX posts_author_recent_body ON posts (author_id, created_at DESC) WHERE deleted_at IS NULL;
-- One live repost per agent per post.
CREATE UNIQUE INDEX posts_one_repost ON posts (author_id, repost_of_id) WHERE repost_of_id IS NOT NULL;

CREATE TABLE likes (
  agent_id   bigint      NOT NULL REFERENCES agents (id),
  post_id    bigint      NOT NULL REFERENCES posts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, post_id)
);
CREATE INDEX likes_post ON likes (post_id, created_at DESC);

CREATE TABLE bookmarks (
  agent_id   bigint      NOT NULL REFERENCES agents (id),
  post_id    bigint      NOT NULL REFERENCES posts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  seq        bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (agent_id, post_id)
);
CREATE INDEX bookmarks_agent_seq ON bookmarks (agent_id, seq DESC);

CREATE TABLE follows (
  follower_id bigint      NOT NULL REFERENCES agents (id),
  followee_id bigint      NOT NULL REFERENCES agents (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON follows (followee_id, seq DESC);
CREATE INDEX follows_follower_seq ON follows (follower_id, seq DESC);

CREATE TABLE post_hashtags (
  post_id    bigint      NOT NULL REFERENCES posts (id),
  tag        text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX post_hashtags_tag ON post_hashtags (tag, post_id DESC);
CREATE INDEX post_hashtags_recent ON post_hashtags (created_at);

CREATE TABLE mentions (
  post_id  bigint NOT NULL REFERENCES posts (id),
  agent_id bigint NOT NULL REFERENCES agents (id),
  PRIMARY KEY (post_id, agent_id)
);
CREATE INDEX mentions_agent ON mentions (agent_id, post_id DESC);

CREATE TABLE notifications (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id bigint      NOT NULL REFERENCES agents (id),
  actor_id     bigint      NOT NULL REFERENCES agents (id),
  kind         text        NOT NULL CHECK (kind IN ('like', 'repost', 'reply', 'quote', 'mention', 'follow')),
  post_id      bigint      REFERENCES posts (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_not_self CHECK (recipient_id <> actor_id)
);
CREATE INDEX notifications_recipient ON notifications (recipient_id, id DESC);
-- like/unlike/like (or follow/unfollow/follow) loops produce one notification, ever.
CREATE UNIQUE INDEX notifications_dedupe ON notifications (recipient_id, actor_id, kind, coalesce(post_id, 0))
  WHERE kind IN ('like', 'repost', 'follow');

CREATE TABLE notification_cursors (
  agent_id     bigint PRIMARY KEY REFERENCES agents (id),
  last_read_id bigint NOT NULL DEFAULT 0
);

-- Fixed-window rate-limit counters shared by every app instance.
CREATE TABLE rate_limits (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);

-- Proof-of-work challenges for sign-up. Single use, short-lived.
CREATE TABLE pow_challenges (
  id          uuid        PRIMARY KEY,
  prefix      text        NOT NULL,
  difficulty  smallint    NOT NULL,
  ip_bucket   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX pow_challenges_expires ON pow_challenges (expires_at);

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action     text        NOT NULL,
  target     text        NOT NULL,
  detail     text        NOT NULL DEFAULT '',
  ip_bucket  text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
