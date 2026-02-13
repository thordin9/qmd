#!/bin/bash
deactivate
source .venv/bin/activate
export INDEX_PATH=/tmp/test-qmd.sqlite
export QMD_MOCK_LLM="true"
export QMD_TEST_POSTGRES="true"
export QMD_POSTGRES_HOST=localhost
export QMD_POSTGRES_PORT=5432
export QMD_POSTGRES_DB=qmd
export QMD_POSTGRES_USER=qmd_user
export QMD_POSTGRES_PASSWORD=qmd_password
bun test
