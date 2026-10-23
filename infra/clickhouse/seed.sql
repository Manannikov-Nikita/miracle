CREATE DATABASE IF NOT EXISTS demo;
CREATE TABLE IF NOT EXISTS demo.sales (id UInt64, sold_at Date, region String, amount Decimal(18,2), customer_id UInt64, comment Nullable(String)) ENGINE=MergeTree ORDER BY id;
INSERT INTO demo.sales SELECT number + 1, toDate('2026-01-01') + toIntervalDay(number % 90), ['Москва','Казань','Самара'][number % 3 + 1], toDecimal64(100 + number * 1.25, 2), 9007199254740993 + number, if(number % 4 = 0, NULL, 'Синтетические данные') FROM numbers(120);
CREATE TABLE IF NOT EXISTS demo.events (event_id UUID, occurred_at DateTime64(3, 'UTC'), category LowCardinality(String), active Bool, tags Array(String)) ENGINE=MergeTree ORDER BY occurred_at;
INSERT INTO demo.events SELECT generateUUIDv4(), toDateTime64('2026-01-01 12:00:00', 3, 'UTC') + toIntervalSecond(number), ['view','click','sale'][number % 3 + 1], number % 2 = 0, ['demo','synthetic'] FROM numbers(60);
