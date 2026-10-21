#!/bin/bash

# Bun loads .env automatically.
DEBUG=${DEBUG:-"app:*"} exec bun --watch src/app.ts
