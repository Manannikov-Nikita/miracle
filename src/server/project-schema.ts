export const projectSchema = `
CREATE TABLE editor_documents(id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document)),revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
CREATE TABLE project_events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,entity_id TEXT,payload TEXT NOT NULL CHECK(json_valid(payload)));
CREATE TABLE project_mutations(scope TEXT NOT NULL,id TEXT NOT NULL,input_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(scope,id));
CREATE TABLE editor_imports(id TEXT PRIMARY KEY);
CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),command_encrypted TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE agent_chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,profile_id TEXT NOT NULL REFERENCES agent_profiles(id),provider TEXT NOT NULL,native_session_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE agent_turns(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES agent_chats(id),request_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,context_json TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
CREATE UNIQUE INDEX agent_one_active_turn ON agent_turns((1)) WHERE status IN ('running','waiting');
CREATE TABLE agent_messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES agent_chats(id),turn_id TEXT REFERENCES agent_turns(id),role TEXT NOT NULL,content TEXT NOT NULL,details_json TEXT,created_at TEXT NOT NULL);
CREATE INDEX agent_messages_chat ON agent_messages(chat_id,created_at);
CREATE INDEX agent_turns_chat ON agent_turns(chat_id,created_at);
PRAGMA user_version=4;
`;
