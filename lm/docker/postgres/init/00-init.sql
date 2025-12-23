-- Create application databases
CREATE DATABASE le_mgr;
CREATE DATABASE n8n;

-- Create application role
CREATE USER le_mgr WITH PASSWORD 'change_me_pg';
GRANT ALL PRIVILEGES ON DATABASE le_mgr TO le_mgr;
GRANT ALL PRIVILEGES ON DATABASE n8n TO le_mgr;
