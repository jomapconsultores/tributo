#!/usr/bin/env python3
import subprocess
import sys

# Read migration SQL
with open('supabase/migrations/001_initial.sql', 'r') as f:
    sql = f.read()

# Split into individual statements
statements = [s.strip() for s in sql.split(';') if s.strip()]

# Execute with psql (requires psql installed and connection string)
import os
conn_str = os.environ.get('DATABASE_URL')
if not conn_str:
    print("ERROR: DATABASE_URL not set")
    print("You need to:")
    print("1. Go to https://supabase.com/dashboard/project/iaxhryjsmapwpjbsnavy")
    print("2. Go to Settings → Database → Connection string")
    print("3. Copy the URI and run: export DATABASE_URL='postgresql://...'")
    print("4. Then run this script again")
    sys.exit(1)

try:
    for i, stmt in enumerate(statements):
        print(f"Executing statement {i+1}/{len(statements)}...", end=" ")
        result = subprocess.run(
            ['psql', conn_str],
            input=stmt,
            text=True,
            capture_output=True
        )
        if result.returncode != 0:
            print(f"ERROR\n{result.stderr}")
            sys.exit(1)
        print("OK")

    print("\n✅ Database migration completed successfully!")
except FileNotFoundError:
    print("ERROR: psql not found. Install PostgreSQL client tools.")
    sys.exit(1)
