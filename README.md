# Dormitricity Worker

This is the backend service for the Dormitricity project, built as a Cloudflare Worker. It handles user authentication, subscription management, data ingestion from the crawler, and real-time notifications.

## Tech Stack

-   **Runtime**: Cloudflare Workers
-   **Language**: TypeScript
-   **Database**: Cloudflare D1
-   **Routing**: Hono-like lightweight routing
-   **Authentication**: Custom JWT implementation (HMAC using SHA-256)
-   **Schema Validation**: Zod (inferred from frontend specs)

## Database Schema

The database schema is defined in `sql/schema.sql` and managed via Cloudflare D1. It includes the following main tables:

-   `users`: Stores user information, including email and hashed passwords.
-   `crawl_targets`: A list of all unique dormitories, identified by a `canonical_id` and a `hashed_dir`.
-   `subscriptions`: Links users to `crawl_targets`. A user can have up to 3 subscriptions.
-   `readings`: Stores the time-series electricity (kWh) data for each dormitory.
-   `dorm_latest`: A cache table holding only the most recent reading for each dorm, used for quick lookups and power trend estimation.
-   `crawl_jobs` & `crawl_slices`: Manage the state of crawling tasks distributed to the `dormitricity-crawler`.
-   `crawl_failures`: Logs any errors encountered by the crawler.

## API Endpoints

The worker exposes a RESTful API to be consumed by the frontend and the crawler.

### Authentication (`/auth`)

-   `POST /auth/register`: Creates a new user account.
-   `POST /auth/login`: Authenticates a user and returns a JWT.
-   `POST /auth/delete`: Deletes the authenticated user's account after email confirmation.

### Subscriptions (`/subs`)

-   `GET /subs`: Lists all subscriptions for the authenticated user, including the latest power data.
-   `POST /subs`: Adds a new dormitory subscription for the user.
-   `DELETE /subs/:hashed_dir`: Removes a subscription.
-   `PUT /subs/:hashed_dir`: Updates notification settings for a subscription (channel, token, thresholds, etc.).
-   `POST /subs/test-notify`: Sends a test message to the configured notification channel.

### Data & Series (`/series`)

-   `GET /series/:hashed_dir`: Returns historical time-series power data for a subscribed dormitory.

### Crawler Endpoints (`/crawler`)

-   `POST /crawler/claim`: Called by the crawler to request a batch (slice) of dormitories to query.
-   `POST /crawler/ingest`: Called by the crawler to submit the fetched power data.
-   `GET /trigger`: A protected endpoint to manually trigger a new crawling job.

## Authentication

The worker uses two distinct JWT-based authentication systems:

1.  **User Authentication**: For frontend users. A standard email/password login flow generates a long-lived JWT, which is required for accessing protected routes like `/subs` and `/series`.
2.  **Crawler Authentication**: For the `dormitricity-crawler`. When a new crawl job is initiated, the worker generates a short-lived, single-purpose JWT. This token grants the crawler permission to use the `/crawler/claim` and `/crawler/ingest` endpoints for that specific job ID only.

## Core Workflows

### Crawling Orchestration

1.  **Cron Trigger**: A cron job defined in `wrangler.toml` runs every 10 minutes.
2.  **Job Creation**: The `scheduled` function fetches all enabled `crawl_targets` from the D1 database.
3.  **Slicing**: It divides the targets into smaller chunks (slices) of 50.
4.  **Dispatch**: It creates a new `crawl_job` and triggers the `dormitricity-crawler` GitHub Actions workflow.
5.  **Tokenization**: A secure, short-lived JWT is passed to the workflow, authorizing it to report back on its findings for this job.

### Notification System

1.  **Trigger**: The notification logic is triggered immediately after new data arrives at the `/crawler/ingest` endpoint.
2.  **Targeted Check**: Instead of scanning all subscriptions, the system queries only the subscriptions corresponding to the `hashed_dir`(s) in the fresh data batch.
3.  **Rule Evaluation**: For each relevant subscription, it checks the latest power data (`last_kwh`, `last_kw`) against the user's configured rules:
    *   **Low Power**: `last_kwh < threshold_kwh`
    *   **Imminent Depletion**: `(last_kwh / -last_kw) < within_hours`
4.  **Cooldown**: An alert is only sent if the configured `cooldown_sec` has passed since the last notification for that subscription.
5.  **Dispatch**: If rules are met, a formatted alert message is sent to the user's chosen channel (Feishu, WeCom, ServerChan) via a webhook POST request.

## Configuration and Deployment

-   **Configuration**: The primary configuration is in `wrangler.toml`. This file defines the worker's name, entry point, cron trigger, D1 database bindings, and environment variables.
-   **Secrets**: Sensitive information like `USER_JWT_SECRET`, `ACTIONS_JWT_SECRET`, and `GH_TOKEN` must be configured as secrets in the Cloudflare dashboard.
-   **Deployment**: The worker is deployed to the Cloudflare global network using the `wrangler` CLI.

    ```bash
    # Deploy to production
    wrangler deploy
    ```

## Local Development

To run the worker locally for development:

1.  **Install Dependencies**: `npm install`
2.  **Create `.dev.vars`**: Create a `.dev.vars` file in the root of the directory to hold your local secrets.

    ```ini
    # .dev.vars
    USER_JWT_SECRET="your-user-secret"
    ACTIONS_JWT_SECRET="your-actions-secret"
    GH_TOKEN="your-github-pat"
    TRIGGER_SECRET="your-trigger-secret"
    ```

3.  **Run the dev server**: Use the `wrangler` CLI to start the local server, which provides hot-reloading and access to a local D1 database.

    ```bash
    wrangler dev
    ```

4.  **Database Migrations**: Apply the database schema to your local or remote D1 instance.

    ```bash
    # Apply to remote DB
    npx wrangler d1 execute <DATABASE_NAME> --remote --file=./sql/schema.sql

    # Apply to local DB
    npx wrangler d1 execute <DATABASE_NAME> --local --file=./sql/schema.sql
    ```
