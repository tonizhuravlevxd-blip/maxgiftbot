CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    max_user_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffles (
    id SERIAL PRIMARY KEY,
    creator_user_id BIGINT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    prize_count INT DEFAULT 1,
    prizes TEXT,
    cover_type TEXT,
    cover_file_ids TEXT,
    source_chat_id BIGINT,
    start_at TIMESTAMP,
    end_at TIMESTAMP NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', -- draft, scheduled, active, finished, cancelled
    publish_in_general BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffle_channels (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    channel_title TEXT,
    is_required BOOLEAN DEFAULT true,
    publish_post BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffle_participants (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    ticket_number BIGINT NOT NULL,
    invited_by BIGINT,
    is_valid BOOLEAN DEFAULT true,
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (raffle_id, user_id, ticket_number)
);

CREATE TABLE IF NOT EXISTS raffle_user_entry (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (raffle_id, user_id)
);

CREATE TABLE IF NOT EXISTS raffle_winners (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    ticket_number BIGINT NOT NULL,
    prize_text TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffle_posts (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    message_id BIGINT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raffle_queue (
    id SERIAL PRIMARY KEY,
    raffle_id INT NOT NULL REFERENCES raffles(id) ON DELETE CASCADE,
    queue_type TEXT NOT NULL DEFAULT 'general_publish', -- general_publish, raffle_start, raffle_finish
    scheduled_at TIMESTAMP NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, done, failed
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL,
    state TEXT,
    data JSONB,
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raffle_queue_status_time
ON raffle_queue(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_raffle_participants_raffle
ON raffle_participants(raffle_id);

CREATE INDEX IF NOT EXISTS idx_raffles_status
ON raffles(status);
