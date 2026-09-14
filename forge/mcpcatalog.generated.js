/**
 * Generated MCP catalog. DO NOT EDIT BY HAND.
 * Source: official MCP Registry + GitHub repository metadata.
 * Generated: 2026-09-14T20:42:17Z; eligible candidates: 803; selected: 100.
 * Refresh: GITHUB_TOKEN=... node scripts/generate-mcp-catalog.mjs
 */
export const GENERATED_MCP_CATALOG = Object.freeze([
  {
    "name": "github",
    "aliases": [
      "github/github-mcp-server"
    ],
    "registryName": "github/github-mcp-server",
    "category": "dev",
    "desc": "GitHub's official MCP server for repositories, issues, pull requests, Actions, code security, and collaboration.",
    "homepage": "https://github.com/github/github-mcp-server",
    "version": "hosted",
    "stars": 32926,
    "score": 190.982,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "env": {},
    "headers": {
      "Authorization": {
        "env": "GITHUB_PERSONAL_ACCESS_TOKEN",
        "prefix": "Bearer ",
        "required": true,
        "secret": true
      }
    }
  },
  {
    "name": "ecc",
    "aliases": [
      "io.github.karljsamuel/mcp-ecc",
      "karljsamuel/mcp-ecc",
      "mcp-ecc"
    ],
    "registryName": "io.github.karljsamuel/mcp-ecc",
    "category": "communication",
    "desc": "Unified MCP server for email, calendars, and contacts across Google, Microsoft 365, Zoho, IMAP/SMTP, CalDAV, and CardDAV.",
    "homepage": "https://github.com/karljsamuel/mcp-ecc",
    "version": "0.6.0",
    "stars": 2,
    "score": 59.293,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "mcp-ecc@0.6.0"
    ],
    "env": {
      "MCP_ENCRYPTION_KEY": {
        "description": "Master key used to encrypt stored credentials (generate a dedicated 32-byte random value)",
        "required": true,
        "secret": true
      }
    }
  },
  {
    "name": "browser-use",
    "aliases": [
      "com.browser-use/browser-use",
      "browser-use/browser-use"
    ],
    "registryName": "com.browser-use/browser-use",
    "category": "browser",
    "desc": "Control a real Chrome browser to complete any task: fill forms, extract data, book flights.",
    "homepage": "https://github.com/browser-use/browser-use",
    "version": "0.13.5",
    "stars": 114611,
    "score": 205.184,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "browser-use==0.13.5",
      "--cli-mcp"
    ],
    "env": {}
  },
  {
    "name": "mcp",
    "aliases": [
      "app.worldmonitor/mcp",
      "koala73/worldmonitor"
    ],
    "registryName": "app.worldmonitor/mcp",
    "category": "observability",
    "desc": "Live markets, conflicts, country risk, chokepoints, energy, and China decision signals. 75 tools.",
    "homepage": "https://github.com/koala73/worldmonitor",
    "version": "1.20.0",
    "stars": 86258,
    "score": 204.393,
    "runtime": "remote",
    "transport": "http",
    "url": "https://worldmonitor.app/mcp",
    "env": {}
  },
  {
    "name": "skills-search",
    "aliases": [
      "ai.com.mcp/skills-search",
      "agentskills/agentskills"
    ],
    "registryName": "ai.com.mcp/skills-search",
    "category": "search",
    "desc": "Search and discover Agent Skills from the skills.sh registry. Powered by HAPI MCP server.",
    "homepage": "https://github.com/agentskills/agentskills",
    "version": "1.0.0",
    "stars": 25326,
    "score": 177.535,
    "runtime": "remote",
    "transport": "http",
    "url": "https://skills-sh.run.mcp.com.ai/mcp",
    "env": {}
  },
  {
    "name": "basebalance",
    "aliases": [
      "cloud.basebalance/basebalance",
      "Conway-Research/automaton"
    ],
    "registryName": "cloud.basebalance/basebalance",
    "category": "other",
    "desc": "USDC-gated Base JSON-RPC: free 10 req/min, $0.50 per 10k. Failover, cache, /mcp, ledger.",
    "homepage": "https://github.com/Conway-Research/automaton.git",
    "version": "1.0.0",
    "stars": 6357,
    "score": 168.76,
    "runtime": "remote",
    "transport": "http",
    "url": "https://basebalance.cloud/mcp",
    "env": {}
  },
  {
    "name": "strata",
    "aliases": [
      "ai.klavis/strata",
      "Klavis-AI/klavis"
    ],
    "registryName": "ai.klavis/strata",
    "category": "other",
    "desc": "MCP server for progressive tool usage at any scale (see https://klavis.ai)",
    "homepage": "https://github.com/Klavis-AI/klavis",
    "version": "1.0.0",
    "stars": 5803,
    "score": 161.276,
    "runtime": "remote",
    "transport": "http",
    "url": "https://strata.klavis.ai/mcp/",
    "env": {}
  },
  {
    "name": "mcp-cloudflare",
    "aliases": [
      "com.cloudflare.mcp/mcp",
      "cloudflare/mcp-server-cloudflare"
    ],
    "registryName": "com.cloudflare.mcp/mcp",
    "category": "cloud",
    "desc": "Cloudflare MCP servers",
    "homepage": "https://github.com/cloudflare/mcp-server-cloudflare",
    "version": "1.0.0",
    "stars": 4193,
    "score": 158.129,
    "runtime": "remote",
    "transport": "http",
    "url": "https://docs.mcp.cloudflare.com/mcp",
    "env": {}
  },
  {
    "name": "exa",
    "aliases": [
      "ai.exa/exa",
      "exa-labs/exa-mcp-server"
    ],
    "registryName": "ai.exa/exa",
    "category": "dev",
    "desc": "Fast, intelligent web search and web crawling.\n\nNew mcp tool: Exa-code is a context tool for coding ",
    "homepage": "https://github.com/exa-labs/exa-mcp-server",
    "version": "3.1.3",
    "stars": 5002,
    "score": 152.573,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.exa.ai/mcp",
    "env": {}
  },
  {
    "name": "travel",
    "aliases": [
      "com.boostedchat/travel",
      "Boosted-Chat/BoostedTravel"
    ],
    "registryName": "com.boostedchat/travel",
    "category": "search",
    "desc": "Flight search & booking for AI agents. 400+ airlines, $20-50 cheaper than OTAs.",
    "homepage": "https://github.com/Boosted-Chat/BoostedTravel",
    "version": "0.1.2",
    "stars": 2014,
    "score": 147.333,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "boostedtravel-mcp@0.1.1"
    ],
    "env": {
      "BOOSTEDTRAVEL_API_KEY": {
        "description": "Your BoostedTravel API key",
        "required": true,
        "secret": true
      }
    }
  },
  {
    "name": "mcp-server",
    "aliases": [
      "com.arcadedb/mcp-server",
      "ArcadeData/arcadedb"
    ],
    "registryName": "com.arcadedb/mcp-server",
    "category": "data",
    "desc": "Built-in MCP server for ArcadeDB multi-model database (graph, document, vector, time-series)",
    "homepage": "https://github.com/ArcadeData/arcadedb",
    "version": "26.4.1-SNAPSHOT",
    "stars": 1153,
    "score": 141.686,
    "runtime": "docker",
    "transport": "stdio",
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "docker.io/arcadedata/arcadedb:26.4.1-SNAPSHOT"
    ],
    "env": {}
  },
  {
    "name": "docs",
    "aliases": [
      "com.empryo/docs",
      "proxysoul/empryo"
    ],
    "registryName": "com.empryo/docs",
    "category": "docs",
    "desc": "Search and read Empryo's documentation. Read-only, no auth, no local access.",
    "homepage": "https://github.com/proxysoul/empryo",
    "version": "1.0.0",
    "stars": 1170,
    "score": 139.282,
    "runtime": "remote",
    "transport": "http",
    "url": "https://empryo.com/mcp",
    "env": {}
  },
  {
    "name": "atlassian-mcp-server",
    "aliases": [
      "com.atlassian/atlassian-mcp-server",
      "atlassian/atlassian-mcp-server"
    ],
    "registryName": "com.atlassian/atlassian-mcp-server",
    "category": "docs",
    "desc": "Connect to Atlassian Jira, Confluence, Loom, and more to search, create, and manage your work.",
    "homepage": "https://github.com/atlassian/atlassian-mcp-server",
    "version": "2.0.0",
    "stars": 1036,
    "score": 136.151,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.atlassian.com/v2/mcp",
    "env": {}
  },
  {
    "name": "commerce-gate",
    "aliases": [
      "com.decionis/commerce-gate"
    ],
    "registryName": "com.decionis/commerce-gate",
    "category": "finance",
    "desc": "Commerce preflights, D365 authorization, signed evidence, and reports; no marketplace or ERP writes.",
    "homepage": "https://github.com/decionis/agent-safe-pipeline",
    "version": "0.1.3",
    "stars": 533,
    "score": 130.557,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@decionis/commerce@0.1.3"
    ],
    "env": {
      "DECIONIS_API_KEY": {
        "description": "Decionis API key. Required for ERP guard, Protocol evaluation, and evidence calls.",
        "required": false,
        "secret": true
      },
      "DECIONIS_ORG_ID": {
        "description": "Organization UUID that binds Protocol evaluation and evidence calls. The ERP guard instead authenticates request.tenant_id with the configured API key.",
        "required": false,
        "secret": false
      },
      "DECIONIS_API_BASE": {
        "description": "Optional Decionis API origin. Defaults to https://api.decionis.com.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "mcp-decionis",
    "aliases": [
      "com.decionis/mcp"
    ],
    "registryName": "com.decionis/mcp",
    "category": "other",
    "desc": "Authorize consequential AI agent actions before execution",
    "homepage": "https://github.com/decionis/agent-safe-pipeline",
    "version": "0.2.0",
    "stars": 533,
    "score": 130.557,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@decionis/mcp@0.2.0"
    ],
    "env": {
      "DECIONIS_POLICY_PATH": {
        "description": "Optional path to the policy file; defaults to ./DECIONIS_POLICY.md in the working directory.",
        "required": false,
        "secret": false
      },
      "DECIONIS_PRESENCE_API_KEY": {
        "description": "Optional Presence tenant API key. When set, decionis_request_presence_verification and decionis_get_presence_verification_status register and call presence.decionis.com; without it the server stays networkless.",
        "required": false,
        "secret": true
      },
      "DECIONIS_PRESENCE_API_URL": {
        "description": "Optional Presence base URL (https only); defaults to https://presence.decionis.com.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "fojin-mcp",
    "aliases": [
      "app.fojin/fojin-mcp",
      "xr843/fojin"
    ],
    "registryName": "app.fojin/fojin-mcp",
    "category": "search",
    "desc": "Buddhist canon tools: search, passages, cross-canon parallels, dictionaries — all URN-cited.",
    "homepage": "https://github.com/xr843/fojin",
    "version": "0.4.0",
    "stars": 341,
    "score": 128.213,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.fojin.ai/mcp",
    "env": {}
  },
  {
    "name": "anki-mcp-server",
    "aliases": [
      "ai.ankimcp/anki-mcp-server",
      "ankimcp/anki-mcp-server"
    ],
    "registryName": "ai.ankimcp/anki-mcp-server",
    "category": "other",
    "desc": "MCP server for Anki flashcards: adaptive review, notes, media, and deck management via AnkiConnect.",
    "homepage": "https://github.com/ankimcp/anki-mcp-server",
    "version": "0.25.1",
    "stars": 480,
    "score": 127.626,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@ankimcp/anki-mcp-server@0.25.1"
    ],
    "env": {}
  },
  {
    "name": "cotal",
    "aliases": [
      "ai.cotal/cotal",
      "Cotal-AI/Cotal"
    ],
    "registryName": "ai.cotal/cotal",
    "category": "search",
    "desc": "cotal.ai actions: product overview, site search, build log, feedback, Cloud waitlist, updates, calls",
    "homepage": "https://github.com/Cotal-AI/Cotal",
    "version": "1.1.0",
    "stars": 283,
    "score": 124.028,
    "runtime": "remote",
    "transport": "http",
    "url": "https://cotal.ai/mcp",
    "env": {}
  },
  {
    "name": "glif",
    "aliases": [
      "app.glif/glif",
      "glifxyz/glif-mcp-server"
    ],
    "registryName": "app.glif/glif",
    "category": "media",
    "desc": "Generate images, video, and audio with Glif's media-generation agent",
    "homepage": "https://github.com/glifxyz/glif-mcp-server",
    "version": "1.0.1",
    "stars": 209,
    "score": 118.905,
    "runtime": "remote",
    "transport": "http",
    "url": "https://glif.app/api/mcp",
    "env": {}
  },
  {
    "name": "runx",
    "aliases": [
      "ai.runx/runx",
      "runxhq/runx"
    ],
    "registryName": "ai.runx/runx",
    "category": "search",
    "desc": "The governed runtime for agent skills. Search the catalog and inspect a skill before running it.",
    "homepage": "https://github.com/runxhq/runx",
    "version": "1.0.0",
    "stars": 88,
    "score": 115.846,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.runx.ai/mcp",
    "env": {}
  },
  {
    "name": "nimrod",
    "aliases": [
      "ai.orchis/nimrod",
      "mixelpixx/Nimrod"
    ],
    "registryName": "ai.orchis/nimrod",
    "category": "search",
    "desc": "Web research for agents: quality-scored Google search, webpage extraction, and deep research.",
    "homepage": "https://github.com/mixelpixx/Nimrod",
    "version": "1.1.1",
    "stars": 257,
    "score": 115.784,
    "runtime": "remote",
    "transport": "http",
    "url": "https://nimrod.orchis.ai/mcp",
    "env": {}
  },
  {
    "name": "unraid",
    "aliases": [
      "ai.dinglebear/unraid"
    ],
    "registryName": "ai.dinglebear/unraid",
    "category": "cloud",
    "desc": "Rust MCP server and CLI for Unraid GraphQL operations across NAS, Docker, VM, and storage workflows.",
    "homepage": "https://github.com/dinglebear-ai/unraid",
    "version": "0.3.0",
    "stars": 129,
    "score": 114.35,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@dinglebear/unraid@0.3.0",
      "mcp"
    ],
    "env": {
      "UNRAID_API_URL": {
        "description": "Full Unraid GraphQL endpoint URL.",
        "required": true,
        "secret": false
      },
      "UNRAID_API_KEY": {
        "description": "Unraid API key.",
        "required": true,
        "secret": true
      },
      "UNRAID_RMCP_VERSION": {
        "description": "Optional GitHub release tag override for the downloaded Unraid RMCP binary.",
        "required": false,
        "secret": false
      },
      "UNRAID_RMCP_REPO": {
        "description": "Optional GitHub owner/repo override for release asset downloads.",
        "required": false,
        "secret": false
      },
      "UNRAID_RMCP_RELEASE_BASE_URL": {
        "description": "Optional release download base URL override.",
        "required": false,
        "secret": false
      },
      "RUST_LOG": {
        "description": "Tracing filter for Unraid RMCP logs.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "unraid-mcp",
    "aliases": [
      "ai.dinglebear/unraid-mcp"
    ],
    "registryName": "ai.dinglebear/unraid-mcp",
    "category": "other",
    "desc": "MCP server for Unraid API — provides tools to interact with an Unraid server's GraphQL API.",
    "homepage": "https://github.com/dinglebear-ai/unraid",
    "version": "2.10.1",
    "stars": 129,
    "score": 114.35,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "unraid-mcp==2.10.1"
    ],
    "env": {
      "UNRAID_API_URL": {
        "description": "Base URL of your Unraid server, e.g. http://192.168.1.100.",
        "required": true,
        "secret": false
      },
      "UNRAID_API_KEY": {
        "description": "Unraid API key for authentication.",
        "required": true,
        "secret": true
      }
    }
  },
  {
    "name": "adeu",
    "aliases": [
      "ai.adeu/adeu",
      "dealfluence/adeu"
    ],
    "registryName": "ai.adeu/adeu",
    "category": "other",
    "desc": "Automated DOCX Redlining Engine",
    "homepage": "https://github.com/dealfluence/adeu",
    "version": "1.7.1",
    "stars": 157,
    "score": 111.934,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@adeu/mcp-server@1.7.1"
    ],
    "env": {}
  },
  {
    "name": "coach-watts",
    "aliases": [
      "com.coachwatts/coach-watts",
      "hdkiller/coach"
    ],
    "registryName": "com.coachwatts/coach-watts",
    "category": "other",
    "desc": "Remote MCP server for training, nutrition, wellness, and performance data with OAuth 2.0.",
    "homepage": "https://github.com/hdkiller/coach",
    "version": "0.5.25",
    "stars": 86,
    "score": 110.359,
    "runtime": "remote",
    "transport": "http",
    "url": "https://coachwatts.com/mcp",
    "env": {}
  },
  {
    "name": "crawlie",
    "aliases": [
      "app.crawlie/crawlie",
      "spronta/crawlie"
    ],
    "registryName": "app.crawlie/crawlie",
    "category": "search",
    "desc": "Technical SEO + GEO (AI-search) site audits: hosted crawls, prioritized fixes, report diffs.",
    "homepage": "https://github.com/spronta/crawlie",
    "version": "0.1.0",
    "stars": 108,
    "score": 109.081,
    "runtime": "remote",
    "transport": "http",
    "url": "https://crawlie.app/mcp",
    "env": {}
  },
  {
    "name": "docs-mcp",
    "aliases": [
      "ac.tandem/docs-mcp",
      "frumu-ai/tandem"
    ],
    "registryName": "ac.tandem/docs-mcp",
    "category": "docs",
    "desc": "Remote MCP server for Tandem docs, install guides, SDKs, workflows, and agent setup help.",
    "homepage": "https://github.com/frumu-ai/tandem",
    "version": "0.3.2",
    "stars": 120,
    "score": 108.834,
    "runtime": "remote",
    "transport": "http",
    "url": "https://tandem.ac/mcp",
    "env": {}
  },
  {
    "name": "mcp-auth0",
    "aliases": [
      "com.auth0/mcp",
      "auth0/auth0-mcp-server"
    ],
    "registryName": "com.auth0/mcp",
    "category": "observability",
    "desc": "Auth0 MCP Server: Manage Auth0 applications, APIs, actions, logs, and forms using natural language",
    "homepage": "https://github.com/auth0/auth0-mcp-server",
    "version": "0.1.0-beta.10",
    "stars": 121,
    "score": 108.344,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "-y",
      "@auth0/auth0-mcp-server@0.1.0-beta.10",
      "run"
    ],
    "env": {}
  },
  {
    "name": "ads",
    "aliases": [
      "com.adspirer/ads",
      "amekala/ads-mcp"
    ],
    "registryName": "com.adspirer/ads",
    "category": "data",
    "desc": "Manage Google, Meta, Amazon, TikTok, LinkedIn & ChatGPT ads. 430 tools for campaigns & analytics.",
    "homepage": "https://github.com/amekala/ads-mcp",
    "version": "1.2.0",
    "stars": 93,
    "score": 107.131,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.adspirer.com/mcp",
    "env": {}
  },
  {
    "name": "kogiqa-mcp",
    "aliases": [
      "com.atagon/kogiqa-mcp",
      "atagon-GmbH/kogiqa-mcp"
    ],
    "registryName": "com.atagon/kogiqa-mcp",
    "category": "browser",
    "desc": "This web browser has been designed to help your agent debug and develop complex web applications.",
    "homepage": "https://github.com/atagon-GmbH/kogiqa-mcp",
    "version": "1.3.103",
    "stars": 103,
    "score": 106.388,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "kogiqa-mcp@1.3.103"
    ],
    "env": {}
  },
  {
    "name": "swiss-caselaw",
    "aliases": [
      "ch.opencaselaw/swiss-caselaw",
      "jonashertner/caselaw-repo-1"
    ],
    "registryName": "ch.opencaselaw/swiss-caselaw",
    "category": "other",
    "desc": "1M+ Swiss court decisions, statutes & doctrine with citation graph (DE/FR/IT). CC0, free, 42 tools.",
    "homepage": "https://github.com/jonashertner/caselaw-repo-1",
    "version": "1.3.0",
    "stars": 66,
    "score": 104.233,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.opencaselaw.ch/mcp",
    "env": {}
  },
  {
    "name": "codescene-mcp-server",
    "aliases": [
      "com.codescene/codescene-mcp-server",
      "codescene-oss/codescene-mcp-server"
    ],
    "registryName": "com.codescene/codescene-mcp-server",
    "category": "dev",
    "desc": "An MCP server that provides CodeScene Code Health analysis tools.",
    "homepage": "https://github.com/codescene-oss/codescene-mcp-server",
    "version": "1.1.0",
    "stars": 64,
    "score": 103.01,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@codescene/codehealth-mcp@0.3.1"
    ],
    "env": {}
  },
  {
    "name": "dexpaprika",
    "aliases": [
      "com.dexpaprika/dexpaprika",
      "coinpaprika/dexpaprika-mcp"
    ],
    "registryName": "com.dexpaprika/dexpaprika",
    "category": "finance",
    "desc": "Real-time DEX and on-chain data: liquidity pools, token prices, swaps, and trading volume.",
    "homepage": "https://github.com/coinpaprika/dexpaprika-mcp",
    "version": "2.3.2",
    "stars": 42,
    "score": 102.228,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.dexpaprika.com/streamable-http",
    "env": {}
  },
  {
    "name": "kin",
    "aliases": [
      "ai.kinlab/kin",
      "firelock-ai/kin"
    ],
    "registryName": "ai.kinlab/kin",
    "category": "dev",
    "desc": "A graph-native code repository for people and AI agents.",
    "homepage": "https://github.com/firelock-ai/kin",
    "version": "0.7.19",
    "stars": 61,
    "score": 101.64,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@kinlab/kin-mcp@0.7.19"
    ],
    "env": {}
  },
  {
    "name": "hypertool-mcp",
    "aliases": [
      "ai.toolprint/hypertool-mcp",
      "toolprint/hypertool-mcp"
    ],
    "registryName": "ai.toolprint/hypertool-mcp",
    "category": "other",
    "desc": "Dynamically expose tools from proxied servers based on an Agent Persona",
    "homepage": "https://github.com/toolprint/hypertool-mcp",
    "version": "0.0.42",
    "stars": 158,
    "score": 101.296,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@toolprint/hypertool-mcp@0.0.42"
    ],
    "env": {}
  },
  {
    "name": "execbro",
    "aliases": [
      "com.execbro/execbro",
      "igorzheludkov/execbro"
    ],
    "registryName": "com.execbro/execbro",
    "category": "observability",
    "desc": "Gives AI agents eyes and hands into running React Native apps: logs, REPL, tap, screenshots",
    "homepage": "https://github.com/igorzheludkov/execbro",
    "version": "2.12.1",
    "stars": 75,
    "score": 101.138,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "execbro@2.12.1"
    ],
    "env": {
      "EXECBRO_API_URL": {
        "description": "Override the license/account API base URL. Defaults to the production endpoint.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "reverie",
    "aliases": [
      "ai.knowall/reverie",
      "knowall-ai/mcp-reverie"
    ],
    "registryName": "ai.knowall/reverie",
    "category": "search",
    "desc": "Graph memory that dreams: Neo4j knowledge-graph memory for AI agents with hybrid search",
    "homepage": "https://github.com/knowall-ai/mcp-reverie",
    "version": "0.5.2",
    "stars": 69,
    "score": 98.609,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@knowall-ai/reverie@0.5.2"
    ],
    "env": {
      "NEO4J_URI": {
        "description": "Bolt URI of the Neo4j 5 database, e.g. bolt://localhost:7687",
        "required": true,
        "secret": false
      },
      "NEO4J_USERNAME": {
        "description": "Neo4j user",
        "required": true,
        "secret": false
      },
      "NEO4J_PASSWORD": {
        "description": "Neo4j password",
        "required": true,
        "secret": true
      },
      "NEO4J_DATABASE": {
        "description": "Database name (Enterprise only; omit on Community Edition)",
        "required": false,
        "secret": false
      },
      "REVERIE_EMBEDDINGS": {
        "description": "Embedding provider for semantic search: local (default, no API key), openai, azure, ollama, voyage or none",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "dbtrail",
    "aliases": [
      "com.dbtrail/dbtrail",
      "dbtrail/bintrail"
    ],
    "registryName": "com.dbtrail/dbtrail",
    "category": "data",
    "desc": "MySQL change tracking with instant row-level recovery and forensic attribution for compliance.",
    "homepage": "https://github.com/dbtrail/bintrail",
    "version": "0.1.0",
    "stars": 52,
    "score": 98.603,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.dbtrail.com/mcp",
    "env": {}
  },
  {
    "name": "mcp-server-blockscout",
    "aliases": [
      "com.blockscout/mcp-server",
      "blockscout/mcp-server"
    ],
    "registryName": "com.blockscout/mcp-server",
    "category": "other",
    "desc": "MCP server for Blockscout",
    "homepage": "https://github.com/blockscout/mcp-server",
    "version": "0.19.0",
    "stars": 47,
    "score": 98.412,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.blockscout.com/mcp",
    "env": {}
  },
  {
    "name": "api",
    "aliases": [
      "com.contrastcyber/api",
      "UPinar/contrastapi"
    ],
    "registryName": "com.contrastcyber/api",
    "category": "communication",
    "desc": "55 tools, 7 Resources, Sigma rules, email SPF/DMARC, MITRE, CVE/KEV, risk_score. No key.",
    "homepage": "https://github.com/UPinar/contrastapi",
    "version": "1.36.2",
    "stars": 33,
    "score": 95.951,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.contrastcyber.com/mcp/",
    "env": {}
  },
  {
    "name": "mcpcap",
    "aliases": [
      "ai.mcpcap/mcpcap",
      "mcpcap/mcpcap"
    ],
    "registryName": "ai.mcpcap/mcpcap",
    "category": "other",
    "desc": "An MCP server for analyzing PCAP files.",
    "homepage": "https://github.com/mcpcap/mcpcap",
    "version": "0.9.6",
    "stars": 51,
    "score": 95.793,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "mcpcap==0.9.6"
    ],
    "env": {}
  },
  {
    "name": "mcp-vaaya-ai",
    "aliases": [
      "ai.vaaya/mcp",
      "vaaya-ai/vaaya-mcp"
    ],
    "registryName": "ai.vaaya/mcp",
    "category": "other",
    "desc": "Paid APIs and tokenized shares for agents. Prepaid funding, including authorized Instinct checkout.",
    "homepage": "https://github.com/vaaya-ai/vaaya-mcp",
    "version": "0.6.8",
    "stars": 43,
    "score": 94.624,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@vaaya/mcp@0.6.8"
    ],
    "env": {}
  },
  {
    "name": "robosystems",
    "aliases": [
      "ai.robosystems/robosystems",
      "RoboFinSystems/robosystems"
    ],
    "registryName": "ai.robosystems/robosystems",
    "category": "other",
    "desc": "Accounting knowledge graphs: SEC XBRL filings, QuickBooks ledgers, reports and forecasts over MCP.",
    "homepage": "https://github.com/RoboFinSystems/robosystems",
    "version": "1.10.2",
    "stars": 25,
    "score": 94.569,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.robosystems.ai/v1/mcp",
    "env": {}
  },
  {
    "name": "remote-desktop-commander",
    "aliases": [
      "app.desktopcommander/remote-desktop-commander",
      "desktop-commander/remote-desktop-commander"
    ],
    "registryName": "app.desktopcommander/remote-desktop-commander",
    "category": "other",
    "desc": "Hosted MCP server connecting claude.ai, ChatGPT and other AI apps to your own computer",
    "homepage": "https://github.com/desktop-commander/remote-desktop-commander",
    "version": "1.0.3",
    "stars": 35,
    "score": 94.423,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.desktopcommander.app/mcp",
    "env": {}
  },
  {
    "name": "wine-registry",
    "aliases": [
      "app.cellarion/wine-registry"
    ],
    "registryName": "app.cellarion/wine-registry",
    "category": "search",
    "desc": "Public wine registry and guides: search wines, grapes, regions, appellations. No account.",
    "homepage": "https://github.com/jagduvi1/Cellarion",
    "version": "1.82.4",
    "stars": 22,
    "score": 93.996,
    "runtime": "remote",
    "transport": "http",
    "url": "https://cellarion.app/api/mcp/public",
    "env": {}
  },
  {
    "name": "expense-budget-tracker",
    "aliases": [
      "com.expense-budget-tracker/expense-budget-tracker",
      "kirill-markin/expense-budget-tracker"
    ],
    "registryName": "com.expense-budget-tracker/expense-budget-tracker",
    "category": "other",
    "desc": "Track expenses, budgets, balances, transfers, and multi-currency reports with OAuth-secured tools.",
    "homepage": "https://github.com/kirill-markin/expense-budget-tracker",
    "version": "1.6.0",
    "stars": 31,
    "score": 93.336,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.expense-budget-tracker.com/mcp",
    "env": {}
  },
  {
    "name": "mcp-trade-it-inc",
    "aliases": [
      "app.tradeit/mcp",
      "trade-it-inc/trade-it-mcp"
    ],
    "registryName": "app.tradeit/mcp",
    "category": "finance",
    "desc": "Trade stock, crypto, and options on Robinhood, ETrade, Webull, Charles Schwab, Coinbase, or Kraken.",
    "homepage": "https://github.com/trade-it-inc/trade-it-mcp",
    "version": "1.0.0",
    "stars": 59,
    "score": 92.68,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.tradeit.app/mcp",
    "env": {}
  },
  {
    "name": "mcp-server-thoughtspot",
    "aliases": [
      "app.thoughtspot/mcp-server",
      "thoughtspot/mcp-server"
    ],
    "registryName": "app.thoughtspot/mcp-server",
    "category": "other",
    "desc": "MCP Server for ThoughtSpot - provides OAuth authentication and tools for querying data",
    "homepage": "https://github.com/thoughtspot/mcp-server",
    "version": "1.0.1",
    "stars": 33,
    "score": 92.252,
    "runtime": "remote",
    "transport": "http",
    "url": "https://agent.thoughtspot.app/mcp",
    "env": {}
  },
  {
    "name": "cellarion",
    "aliases": [
      "app.cellarion/cellarion"
    ],
    "registryName": "app.cellarion/cellarion",
    "category": "other",
    "desc": "Wine cellar manager: bottles, racks, drink windows, pairings and a shared wine registry.",
    "homepage": "https://github.com/jagduvi1/Cellarion",
    "version": "1.82.4",
    "stars": 22,
    "score": 91.996,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "cellarion-mcp@0.1.1"
    ],
    "env": {
      "CELLARION_TOKEN": {
        "description": "Personal API token from Settings -> API tokens (starts with cel_).",
        "required": true,
        "secret": true
      },
      "CELLARION_URL": {
        "description": "Base URL of your Cellarion server. Leave unset for the hosted app.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "mcp-devcyclehq",
    "aliases": [
      "com.devcycle/mcp",
      "DevCycleHQ/cli"
    ],
    "registryName": "com.devcycle/mcp",
    "category": "other",
    "desc": "DevCycle MCP server for feature flag management",
    "homepage": "https://github.com/DevCycleHQ/cli",
    "version": "6.3.2",
    "stars": 20,
    "score": 91.262,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.devcycle.com/mcp",
    "env": {}
  },
  {
    "name": "servicegraph",
    "aliases": [
      "co.servicegraph.mcp/servicegraph",
      "nostrband/servicegraph"
    ],
    "registryName": "co.servicegraph.mcp/servicegraph",
    "category": "observability",
    "desc": "Datasets for founders: directories, newsletters, and agencies, with metrics attached.",
    "homepage": "https://github.com/nostrband/servicegraph",
    "version": "0.1.1",
    "stars": 62,
    "score": 90.404,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.servicegraph.co",
    "env": {}
  },
  {
    "name": "dbmcp",
    "aliases": [
      "ai.haymon/dbmcp",
      "haymon-ai/dbmcp"
    ],
    "registryName": "ai.haymon/dbmcp",
    "category": "data",
    "desc": "Database MCP server for MySQL, MariaDB, PostgreSQL & SQLite with PII redaction and write-prevention",
    "homepage": "https://github.com/haymon-ai/dbmcp",
    "version": "0.13.2",
    "stars": 31,
    "score": 90.373,
    "runtime": "docker",
    "transport": "stdio",
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "ghcr.io/haymon-ai/dbmcp:0.13.2",
      "stdio"
    ],
    "env": {}
  },
  {
    "name": "zenbrain",
    "aliases": [
      "ai.zensation/zenbrain",
      "zensation-ai/zenbrain"
    ],
    "registryName": "ai.zensation/zenbrain",
    "category": "data",
    "desc": "Seven-layer agent memory: episodic, semantic, procedural and core. Local SQLite, no account.",
    "homepage": "https://github.com/zensation-ai/zenbrain",
    "version": "0.1.3",
    "stars": 23,
    "score": 90.281,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@zensation/mcp@0.1.3"
    ],
    "env": {
      "ZENBRAIN_DB": {
        "description": "Path to the SQLite file that holds the memory. Use ':memory:' for a store that is discarded when the process exits.",
        "required": false,
        "secret": false
      },
      "ZENBRAIN_CONTEXTS": {
        "description": "Comma-separated context domains for cross-context memory.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "spotdb",
    "aliases": [
      "ai.aliengiraffe/spotdb",
      "aliengiraffe/spotdb"
    ],
    "registryName": "ai.aliengiraffe/spotdb",
    "category": "productivity",
    "desc": "Ephemeral data sandbox for AI workflows with guardrails and security",
    "homepage": "https://github.com/aliengiraffe/spotdb",
    "version": "0.1.0",
    "stars": 21,
    "score": 88.696,
    "runtime": "docker",
    "transport": "stdio",
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "X-API-Key",
      "docker.io/aliengiraffe/spotdb:0.1.0"
    ],
    "env": {
      "X-API-Key": {
        "description": "Optional API key for request authentication",
        "required": false,
        "secret": true
      }
    }
  },
  {
    "name": "mcp-wavespeedai",
    "aliases": [
      "ai.wavespeed/mcp",
      "WaveSpeedAI/mcp-server"
    ],
    "registryName": "ai.wavespeed/mcp",
    "category": "observability",
    "desc": "Run any model on the live WaveSpeed catalog: image, video, audio, 3D.",
    "homepage": "https://github.com/WaveSpeedAI/mcp-server",
    "version": "1.0.7",
    "stars": 31,
    "score": 88.67,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@wavespeed/mcp@1.0.7"
    ],
    "env": {
      "WAVESPEED_API_KEY": {
        "description": "WaveSpeed API key (https://wavespeed.ai/accesskey). Optional when the wavespeed CLI is logged in.",
        "required": false,
        "secret": true
      },
      "WAVESPEED_BASE_URL": {
        "description": "Override the WaveSpeed API base URL. Defaults to https://api.wavespeed.ai.",
        "required": false,
        "secret": false
      },
      "WAVESPEED_CLIENT_NAME": {
        "description": "Override the client name reported for channel attribution. Defaults to wavespeed-mcp.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "acquisition-gov-mcp",
    "aliases": [
      "com.1102tools/acquisition-gov-mcp"
    ],
    "registryName": "com.1102tools/acquisition-gov-mcp",
    "category": "other",
    "desc": "Acquisition.gov FAR Overhaul model parts, agency deviations, PDFs, and guidance. 5 tools.",
    "homepage": "https://github.com/1102tools-dev/federal-contracting-mcps",
    "version": "1.0.8",
    "stars": 22,
    "score": 88.264,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "acquisition-gov-mcp==1.0.8"
    ],
    "env": {}
  },
  {
    "name": "bls-oews-mcp",
    "aliases": [
      "com.1102tools/bls-oews-mcp"
    ],
    "registryName": "com.1102tools/bls-oews-mcp",
    "category": "finance",
    "desc": "BLS access readiness and Occupational Employment and Wage Statistics market wages. 8 tools.",
    "homepage": "https://github.com/1102tools-dev/federal-contracting-mcps",
    "version": "1.0.10",
    "stars": 22,
    "score": 88.264,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "bls-oews-mcp==1.0.10"
    ],
    "env": {
      "BLS_API_KEY": {
        "description": "Optional free BLS API key for higher request limits.",
        "required": false,
        "secret": true
      }
    }
  },
  {
    "name": "ecfr-mcp",
    "aliases": [
      "com.1102tools/ecfr-mcp"
    ],
    "registryName": "com.1102tools/ecfr-mcp",
    "category": "dev",
    "desc": "Electronic Code of Federal Regulations including FAR, DFARS, and agency supplements. 13 tools.",
    "homepage": "https://github.com/1102tools-dev/federal-contracting-mcps",
    "version": "1.0.10",
    "stars": 22,
    "score": 88.264,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "ecfr-mcp==1.0.10"
    ],
    "env": {}
  },
  {
    "name": "airtable",
    "aliases": [
      "ai.waystation/airtable"
    ],
    "registryName": "ai.waystation/airtable",
    "category": "other",
    "desc": "Access and manage your Airtable bases, tables, and records seamlessly",
    "homepage": "https://github.com/waystation-ai/mcp",
    "version": "0.3.1",
    "stars": 62,
    "score": 87.238,
    "runtime": "remote",
    "transport": "http",
    "url": "https://waystation.ai/airtable/mcp",
    "env": {}
  },
  {
    "name": "gmail",
    "aliases": [
      "ai.waystation/gmail"
    ],
    "registryName": "ai.waystation/gmail",
    "category": "communication",
    "desc": "Read emails, send messages, and manage labels in your Gmail account.",
    "homepage": "https://github.com/waystation-ai/mcp",
    "version": "0.3.1",
    "stars": 62,
    "score": 87.238,
    "runtime": "remote",
    "transport": "http",
    "url": "https://waystation.ai/gmail/mcp",
    "env": {}
  },
  {
    "name": "jira",
    "aliases": [
      "ai.waystation/jira"
    ],
    "registryName": "ai.waystation/jira",
    "category": "dev",
    "desc": "Track issues, manage projects, and streamline workflows in Jira.",
    "homepage": "https://github.com/waystation-ai/mcp",
    "version": "0.3.1",
    "stars": 62,
    "score": 87.238,
    "runtime": "remote",
    "transport": "http",
    "url": "https://waystation.ai/jira/mcp",
    "env": {}
  },
  {
    "name": "mcp-appfigures",
    "aliases": [
      "com.appfigures/mcp",
      "appfigures/cli"
    ],
    "registryName": "com.appfigures/mcp",
    "category": "data",
    "desc": "Access your app analytics, ASO tools, and app market intelligence with Appfigures.",
    "homepage": "https://github.com/appfigures/cli",
    "version": "3.0.0",
    "stars": 20,
    "score": 86.52,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@appfigures/cli@3.0.0",
      "mcp"
    ],
    "env": {
      "APPFIGURES_API_KEY": {
        "description": "Appfigures personal access token. Optional; omit it to sign in with `af auth login` instead. Read more at https://help.appfigures.com/en/article/1chf6wf",
        "required": false,
        "secret": true
      }
    }
  },
  {
    "name": "mcp-jdguggs10",
    "aliases": [
      "app.flaim/mcp",
      "jdguggs10/flaim"
    ],
    "registryName": "app.flaim/mcp",
    "category": "other",
    "desc": "Read-only fantasy analysis for ESPN, Yahoo, and Sleeper leagues via MCP",
    "homepage": "https://github.com/jdguggs10/flaim",
    "version": "1.0.1",
    "stars": 20,
    "score": 86.499,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.flaim.app/mcp",
    "env": {}
  },
  {
    "name": "mcp-apideck-libraries",
    "aliases": [
      "com.apideck/mcp",
      "apideck-libraries/mcp"
    ],
    "registryName": "com.apideck/mcp",
    "category": "other",
    "desc": "Apideck Unified API MCP — 330 tools across 200+ SaaS connectors (accounting, CRM, HRIS, ATS).",
    "homepage": "https://github.com/apideck-libraries/mcp",
    "version": "0.1.13",
    "stars": 16,
    "score": 84.76,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@apideck/mcp@0.1.13"
    ],
    "env": {
      "APIDECK_API_KEY": {
        "description": "Your Apideck API key (from https://platform.apideck.com/configuration/api-keys).",
        "required": true,
        "secret": true
      },
      "APIDECK_APP_ID": {
        "description": "Your Apideck application ID (from https://platform.apideck.com/configuration/api-keys).",
        "required": true,
        "secret": false
      },
      "APIDECK_CONSUMER_ID": {
        "description": "The end-user/customer ID whose Vault connections should be used.",
        "required": true,
        "secret": false
      }
    }
  },
  {
    "name": "automox-mcp",
    "aliases": [
      "com.automox/automox-mcp",
      "AutomoxCommunity/automox-mcp"
    ],
    "registryName": "com.automox/automox-mcp",
    "category": "other",
    "desc": "Official MCP server for Automox. Manage devices, patches, and policies in natural language.",
    "homepage": "https://github.com/AutomoxCommunity/automox-mcp",
    "version": "2.2.9",
    "stars": 12,
    "score": 84.031,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "automox-mcp==2.2.9"
    ],
    "env": {
      "AUTOMOX_API_KEY": {
        "description": "Your Automox API key",
        "required": true,
        "secret": true
      },
      "AUTOMOX_ACCOUNT_UUID": {
        "description": "Account UUID from Automox Settings > Secrets & Keys",
        "required": true,
        "secret": false
      },
      "AUTOMOX_ORG_ID": {
        "description": "Numeric Automox organization ID. Recommended — required by most tools, optional for tools that don't need org context.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "dns",
    "aliases": [
      "com.blackveilsecurity/dns",
      "MadaBurns/bv-mcp"
    ],
    "registryName": "com.blackveilsecurity/dns",
    "category": "communication",
    "desc": "DNS and email security scanner with 80 MCP tools for SPF, DMARC, DNSSEC, SSL, and brand audits.",
    "homepage": "https://github.com/MadaBurns/bv-mcp",
    "version": "3.80.0",
    "stars": 9,
    "score": 83.761,
    "runtime": "remote",
    "transport": "http",
    "url": "https://dns-mcp.blackveilsecurity.com/mcp",
    "env": {}
  },
  {
    "name": "mcp-orangeproai",
    "aliases": [
      "ai.orangepro/mcp",
      "OrangeproAI/orangepro-mcp"
    ],
    "registryName": "ai.orangepro/mcp",
    "category": "other",
    "desc": "Find test gaps, generate grounded tests, and dynamically prove behavior with mutation testing.",
    "homepage": "https://github.com/OrangeproAI/orangepro-mcp",
    "version": "0.2.40",
    "stars": 17,
    "score": 83.496,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@orangepro/mcp-server@0.2.40",
      "mcp"
    ],
    "env": {
      "OPENAI_API_KEY": {
        "description": "Optional OpenAI BYOK key for AI candidate links and test generation.",
        "required": false,
        "secret": true
      },
      "ANTHROPIC_API_KEY": {
        "description": "Optional Anthropic BYOK key for AI candidate links and test generation.",
        "required": false,
        "secret": true
      },
      "OLLAMA_BASE_URL": {
        "description": "Optional Ollama endpoint for local AI candidate links and test generation.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "mcp-himalayas-app",
    "aliases": [
      "app.himalayas/mcp",
      "Himalayas-App/himalayas-mcp"
    ],
    "registryName": "app.himalayas/mcp",
    "category": "search",
    "desc": "Search and post remote jobs, browse companies, check salaries, and find talent on Himalayas.app",
    "homepage": "https://github.com/Himalayas-App/himalayas-mcp",
    "version": "1.0.2",
    "stars": 19,
    "score": 83.463,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.himalayas.app/mcp",
    "env": {}
  },
  {
    "name": "mcp-explorium",
    "aliases": [
      "ai.explorium/mcp-explorium",
      "explorium-ai/mcp-explorium"
    ],
    "registryName": "ai.explorium/mcp-explorium",
    "category": "communication",
    "desc": "Access live company and contact data from Explorium's AgentSource B2B platform.",
    "homepage": "https://github.com/explorium-ai/mcp-explorium",
    "version": "1.0.1",
    "stars": 21,
    "score": 83.322,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp-github-registry.explorium.ai/mcp",
    "env": {}
  },
  {
    "name": "embedded-docs",
    "aliases": [
      "ai.byteask/embedded-docs",
      "ByteAsk/ByteAsk-Embedded-MCP"
    ],
    "registryName": "ai.byteask/embedded-docs",
    "category": "docs",
    "desc": "Page-cited retrieval for embedded docs, datasheets, MISRA, CMSIS, and RTOS references.",
    "homepage": "https://github.com/ByteAsk/ByteAsk-Embedded-MCP",
    "version": "1.0.1",
    "stars": 23,
    "score": 82.407,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.byteask.ai/mcp",
    "env": {}
  },
  {
    "name": "the-scribble-thing",
    "aliases": [
      "club.boringstuff/the-scribble-thing",
      "Boring-Stuff-Club/the-scribble-thing-skill"
    ],
    "registryName": "club.boringstuff/the-scribble-thing",
    "category": "media",
    "desc": "Turn one line-art image into a prompt-directed, hand-drawn scribe animation MP4.",
    "homepage": "https://github.com/Boring-Stuff-Club/the-scribble-thing-skill",
    "version": "1.0.0",
    "stars": 17,
    "score": 82.34,
    "runtime": "remote",
    "transport": "http",
    "url": "https://scribble.boringstuff.club/mcp",
    "env": {}
  },
  {
    "name": "sentinelx",
    "aliases": [
      "app.sentinelx/sentinelx",
      "pensados/sentinelx-cloud-core"
    ],
    "registryName": "app.sentinelx/sentinelx",
    "category": "other",
    "desc": "Operate Linux, macOS and Windows from your LLM. Every action runs through an auditable allowlist.",
    "homepage": "https://github.com/pensados/sentinelx-cloud-core",
    "version": "0.6.0",
    "stars": 8,
    "score": 81.898,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.sentinelx.app/mcp/mcp",
    "env": {}
  },
  {
    "name": "mcp-withoneai",
    "aliases": [
      "ai.withone/mcp",
      "withoneai/mcp"
    ],
    "registryName": "ai.withone/mcp",
    "category": "search",
    "desc": "Search, document and execute authenticated API calls across 700+ apps via one MCP server",
    "homepage": "https://github.com/withoneai/mcp",
    "version": "1.2.4",
    "stars": 10,
    "score": 81.387,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@withone/mcp@1.2.4"
    ],
    "env": {
      "ONE_SECRET": {
        "description": "One API key from https://app.withone.ai/settings/api-keys",
        "required": true,
        "secret": true
      },
      "ONE_PERMISSIONS": {
        "description": "Restrict actions by HTTP method: read (GET), write (GET/POST/PUT/PATCH) or admin (all)",
        "required": false,
        "secret": false
      },
      "ONE_CONNECTION_KEYS": {
        "description": "Comma-separated connection keys the agent may see, or * for all",
        "required": false,
        "secret": false
      },
      "ONE_ACTION_IDS": {
        "description": "Comma-separated action IDs the agent may see and run, or * for all",
        "required": false,
        "secret": false
      },
      "ONE_KNOWLEDGE_AGENT": {
        "description": "Set true to drop execute_one_action and run in knowledge-only mode",
        "required": false,
        "secret": false
      },
      "ONE_IDENTITY": {
        "description": "Scope connections to a single user, team, organization or project identifier",
        "required": false,
        "secret": false
      },
      "ONE_IDENTITY_TYPE": {
        "description": "Type of ONE_IDENTITY: user, team, organization or project",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "astravue-mcp",
    "aliases": [
      "com.astravue/astravue-mcp",
      "AstravueOrg/astravue-mcp-server"
    ],
    "registryName": "com.astravue/astravue-mcp",
    "category": "productivity",
    "desc": "Manage projects, tasks, time tracking, and team collaboration through natural language.",
    "homepage": "https://github.com/AstravueOrg/astravue-mcp-server",
    "version": "1.0.1",
    "stars": 12,
    "score": 81.35,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.astravue.com/mcp",
    "env": {}
  },
  {
    "name": "streams",
    "aliases": [
      "com.dbconvert/streams",
      "slotix/dbconvert-streams-public"
    ],
    "registryName": "com.dbconvert/streams",
    "category": "data",
    "desc": "Read-only SQL across your PostgreSQL, MySQL, S3 buckets and local data files, in one query.",
    "homepage": "https://github.com/slotix/dbconvert-streams-public",
    "version": "2.7.3",
    "stars": 24,
    "score": 81.204,
    "runtime": "docker",
    "transport": "stdio",
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "docker.io/slotix/stream-mcp:2.7.3"
    ],
    "env": {}
  },
  {
    "name": "yarr",
    "aliases": [
      "ai.dinglebear/yarr",
      "dinglebear-ai/yarr"
    ],
    "registryName": "ai.dinglebear/yarr",
    "category": "other",
    "desc": "Self-hosted media fleet operations across Sonarr, Radarr, Plex, and related apps over MCP and CLI.",
    "homepage": "https://github.com/dinglebear-ai/yarr",
    "version": "2.2.2",
    "stars": 12,
    "score": 80.776,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@dinglebear/yarr@2.2.2",
      "mcp"
    ],
    "env": {
      "YARR_SONARR_URL": {
        "description": "Optional Sonarr base URL.",
        "required": false,
        "secret": false
      },
      "YARR_SONARR_API_KEY": {
        "description": "Optional Sonarr API key.",
        "required": false,
        "secret": true
      },
      "YARR_RADARR_URL": {
        "description": "Optional Radarr base URL.",
        "required": false,
        "secret": false
      },
      "YARR_RADARR_API_KEY": {
        "description": "Optional Radarr API key.",
        "required": false,
        "secret": true
      },
      "YARR_PLEX_URL": {
        "description": "Optional Plex base URL.",
        "required": false,
        "secret": false
      },
      "YARR_PLEX_TOKEN": {
        "description": "Optional Plex token.",
        "required": false,
        "secret": true
      },
      "YARR_VERSION": {
        "description": "Optional GitHub release tag override for the downloaded Yarr binary.",
        "required": false,
        "secret": false
      },
      "YARR_REPO": {
        "description": "Optional GitHub owner/repo override for release asset downloads.",
        "required": false,
        "secret": false
      },
      "YARR_RELEASE_BASE_URL": {
        "description": "Optional release download base URL override.",
        "required": false,
        "secret": false
      },
      "RUST_LOG": {
        "description": "Tracing filter for Yarr logs.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "yarr-mcp",
    "aliases": [
      "ai.dinglebear/yarr-mcp",
      "jmagar/yarr"
    ],
    "registryName": "ai.dinglebear/yarr-mcp",
    "category": "other",
    "desc": "Rust MCP and CLI server for Sonarr, Radarr, Prowlarr, Plex, Jellyfin, and download clients.",
    "homepage": "https://github.com/jmagar/yarr",
    "version": "1.1.1",
    "stars": 12,
    "score": 80.776,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "yarr-mcp@1.1.1",
      "mcp"
    ],
    "env": {
      "YARR_SONARR_URL": {
        "description": "Optional Sonarr base URL.",
        "required": false,
        "secret": false
      },
      "YARR_SONARR_API_KEY": {
        "description": "Optional Sonarr API key.",
        "required": false,
        "secret": true
      },
      "YARR_RADARR_URL": {
        "description": "Optional Radarr base URL.",
        "required": false,
        "secret": false
      },
      "YARR_RADARR_API_KEY": {
        "description": "Optional Radarr API key.",
        "required": false,
        "secret": true
      },
      "YARR_PLEX_URL": {
        "description": "Optional Plex base URL.",
        "required": false,
        "secret": false
      },
      "YARR_PLEX_TOKEN": {
        "description": "Optional Plex token.",
        "required": false,
        "secret": true
      },
      "YARR_VERSION": {
        "description": "Optional GitHub release tag override for the downloaded Yarr binary.",
        "required": false,
        "secret": false
      },
      "YARR_REPO": {
        "description": "Optional GitHub owner/repo override for release asset downloads.",
        "required": false,
        "secret": false
      },
      "YARR_RELEASE_BASE_URL": {
        "description": "Optional release download base URL override.",
        "required": false,
        "secret": false
      },
      "RUST_LOG": {
        "description": "Tracing filter for Yarr logs.",
        "required": false,
        "secret": false
      }
    }
  },
  {
    "name": "engram",
    "aliases": [
      "app.getengram/engram",
      "get-engram/engram"
    ],
    "registryName": "app.getengram/engram",
    "category": "search",
    "desc": "Persistent, verbatim, searchable memory for AI assistants — one memory across every MCP client.",
    "homepage": "https://github.com/get-engram/engram",
    "version": "0.1.0",
    "stars": 12,
    "score": 80.433,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.getengram.app/mcp",
    "env": {}
  },
  {
    "name": "churnkey",
    "aliases": [
      "co.churnkey/churnkey",
      "churnkey/sdk"
    ],
    "registryName": "co.churnkey/churnkey",
    "category": "observability",
    "desc": "Read and manage Churnkey cancel flows, retention metrics, and payment recovery",
    "homepage": "https://github.com/churnkey/sdk",
    "version": "2.3.0",
    "stars": 22,
    "score": 79.524,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.churnkey.co/mcp",
    "env": {}
  },
  {
    "name": "chiplab",
    "aliases": [
      "ai.veecle/chiplab",
      "veecle/chiplab"
    ],
    "registryName": "ai.veecle/chiplab",
    "category": "other",
    "desc": "Run, build, and validate firmware on virtual hardware from your AI agent. Hardware knowledge corpus.",
    "homepage": "https://github.com/veecle/chiplab",
    "version": "1.0.0",
    "stars": 16,
    "score": 79.336,
    "runtime": "remote",
    "transport": "http",
    "url": "https://chiplab.veecle.ai/mcp",
    "env": {}
  },
  {
    "name": "mcp-fipex-labs",
    "aliases": [
      "br.com.fipex/mcp",
      "fipex-labs/dataset"
    ],
    "registryName": "br.com.fipex/mcp",
    "category": "search",
    "desc": "Brazilian FIPE vehicle reference prices: search, current price, history and comparison. Keyless.",
    "homepage": "https://github.com/fipex-labs/dataset",
    "version": "1.0.0",
    "stars": 12,
    "score": 79.299,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.fipex.com.br/mcp",
    "env": {}
  },
  {
    "name": "social-insights",
    "aliases": [
      "ai.xpoz/social-insights",
      "xpozpublic/xpoz-mcp"
    ],
    "registryName": "ai.xpoz/social-insights",
    "category": "search",
    "desc": "Twitter/X, Instagram, Reddit & TikTok data for AI agents. Billions of posts. No API keys.",
    "homepage": "https://github.com/xpozpublic/xpoz-mcp",
    "version": "1.4.1",
    "stars": 12,
    "score": 79.124,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.xpoz.ai/mcp",
    "env": {}
  },
  {
    "name": "task-mcp",
    "aliases": [
      "ai.parallel/task-mcp",
      "parallel-web/task-mcp"
    ],
    "registryName": "ai.parallel/task-mcp",
    "category": "search",
    "desc": "An MCP server for deep research or task groups",
    "homepage": "https://github.com/parallel-web/task-mcp",
    "version": "1.0.0",
    "stars": 16,
    "score": 78.642,
    "runtime": "remote",
    "transport": "http",
    "url": "https://task-mcp.parallel.ai/mcp",
    "env": {}
  },
  {
    "name": "mcp-facetoplace",
    "aliases": [
      "co.workix/mcp",
      "facetoplace/Workix"
    ],
    "registryName": "co.workix/mcp",
    "category": "other",
    "desc": "Remote jobs, freelance gigs, vacancies. 24 boards: Upwork, Freelancer, RemoteOK, hh.ru, Kwork.",
    "homepage": "https://github.com/facetoplace/Workix",
    "version": "1.0.0",
    "stars": 13,
    "score": 78.314,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@workix/mcp@1.0.0"
    ],
    "env": {
      "WORKIX_API": {
        "description": "Workix hub API base URL (default https://workix.co)",
        "required": false,
        "secret": false
      },
      "WORKIX_AGENT_KEY": {
        "description": "Agent key for hub write actions (optional for public search)",
        "required": false,
        "secret": true
      }
    }
  },
  {
    "name": "mcp-happendev",
    "aliases": [
      "app.kanera/mcp",
      "happendev/Kanera"
    ],
    "registryName": "app.kanera/mcp",
    "category": "other",
    "desc": "Manage Kanera workspaces, boards, cards, checklists, comments, notes, automations, and reports.",
    "homepage": "https://github.com/happendev/Kanera",
    "version": "3.2.0",
    "stars": 10,
    "score": 77.84,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.kanera.app/mcp",
    "env": {}
  },
  {
    "name": "gondola",
    "aliases": [
      "ai.gondola/gondola",
      "gondola-ai/gondola-mcp"
    ],
    "registryName": "ai.gondola/gondola",
    "category": "search",
    "desc": "Travel award search: compare cash vs points on hotels, flights & cars, cents-per-point, and book.",
    "homepage": "https://github.com/gondola-ai/gondola-mcp",
    "version": "0.1.5",
    "stars": 8,
    "score": 77.543,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.gondola.ai/mcp",
    "env": {}
  },
  {
    "name": "analytics",
    "aliases": [
      "ai.mcpanalytics/analytics",
      "embeddedlayers/mcp-analytics"
    ],
    "registryName": "ai.mcpanalytics/analytics",
    "category": "data",
    "desc": "The statistical analyst in your AI chat — validated, citable, re-runnable analysis of your data.",
    "homepage": "https://github.com/embeddedlayers/mcp-analytics",
    "version": "1.0.7",
    "stars": 7,
    "score": 76.784,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.mcpanalytics.ai/auth0",
    "env": {}
  },
  {
    "name": "etincel-nonfiction",
    "aliases": [
      "ai.etincel/etincel-nonfiction",
      "AIStoryHub/etincel"
    ],
    "registryName": "ai.etincel/etincel-nonfiction",
    "category": "other",
    "desc": "Trainable non-fiction writing voice, presets, and an anti-AI-tells audit for Claude, via MCP.",
    "homepage": "https://github.com/AIStoryHub/etincel",
    "version": "0.10.1",
    "stars": 8,
    "score": 76.56,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "etincel@0.10.1",
      "serve"
    ],
    "env": {}
  },
  {
    "name": "growmos",
    "aliases": [
      "com.codician/growmos",
      "codician-team/growmos"
    ],
    "registryName": "com.codician/growmos",
    "category": "other",
    "desc": "Living knowledge graph for your repo: query with citations, remember/link facts, fact-check claims.",
    "homepage": "https://github.com/codician-team/growmos",
    "version": "0.1.5",
    "stars": 9,
    "score": 76.329,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "growmos==0.1.5",
      "mcp"
    ],
    "env": {}
  },
  {
    "name": "search-mcp",
    "aliases": [
      "ai.parallel/search-mcp",
      "parallel-web/search-mcp"
    ],
    "registryName": "ai.parallel/search-mcp",
    "category": "search",
    "desc": "The best web search for your AI Agent",
    "homepage": "https://github.com/parallel-web/search-mcp",
    "version": "1.0.0",
    "stars": 17,
    "score": 76.307,
    "runtime": "remote",
    "transport": "http",
    "url": "https://search-mcp.parallel.ai/mcp",
    "env": {}
  },
  {
    "name": "ato-mcp",
    "aliases": [
      "au.com.ato-mcp/ato-mcp",
      "william-laverty/ato-mcp"
    ],
    "registryName": "au.com.ato-mcp/ato-mcp",
    "category": "docs",
    "desc": "Australian tax knowledge base for agents: 34,500+ ATO documents, cited answers to any tax question.",
    "homepage": "https://github.com/william-laverty/ato-mcp",
    "version": "2.1.5",
    "stars": 10,
    "score": 76.302,
    "runtime": "remote",
    "transport": "http",
    "url": "https://api.ato-mcp.com.au/mcp",
    "env": {}
  },
  {
    "name": "read-only-local-mysql-mcp-server",
    "aliases": [
      "capital.hove/read-only-local-mysql-mcp-server",
      "hovecapital/read-only-local-mysql-mcp-server"
    ],
    "registryName": "capital.hove/read-only-local-mysql-mcp-server",
    "category": "data",
    "desc": "MCP server for read-only MySQL database queries in Claude Desktop",
    "homepage": "https://github.com/hovecapital/read-only-local-mysql-mcp-server",
    "version": "0.1.1",
    "stars": 7,
    "score": 76.203,
    "runtime": "node",
    "transport": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@hovecapital/read-only-mysql-mcp-server@0.1.1"
    ],
    "env": {}
  },
  {
    "name": "sleepwalker",
    "aliases": [
      "ai.sleepwalker/sleepwalker",
      "followanton/sleepwalker"
    ],
    "registryName": "ai.sleepwalker/sleepwalker",
    "category": "other",
    "desc": "AI Visibility and Content Intelligence tools for Claude and MCP-compatible agents.",
    "homepage": "https://github.com/followanton/sleepwalker",
    "version": "0.1.1",
    "stars": 25,
    "score": 76.192,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.sleepwalker.ai/mcp",
    "env": {}
  },
  {
    "name": "outlit",
    "aliases": [
      "ai.outlit/outlit",
      "OutlitAI/outlit-sdk"
    ],
    "registryName": "ai.outlit/outlit",
    "category": "productivity",
    "desc": "Outlit gives agents real-time understanding of customers to automate support and revenue workflows.",
    "homepage": "https://github.com/OutlitAI/outlit-sdk",
    "version": "1.0.0",
    "stars": 6,
    "score": 75.69,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.outlit.ai/mcp",
    "env": {}
  },
  {
    "name": "lenny-rachitsky-podcast",
    "aliases": [
      "ai.com.mcp/lenny-rachitsky-podcast"
    ],
    "registryName": "ai.com.mcp/lenny-rachitsky-podcast",
    "category": "other",
    "desc": "MCP server for structured access to Lenny Rachitsky podcast transcripts. For content creators.",
    "homepage": "https://github.com/la-rebelion/hapimcp",
    "version": "0.6.0",
    "stars": 9,
    "score": 75.571,
    "runtime": "remote",
    "transport": "http",
    "url": "https://lenny-rachitsky.run.mcp.com.ai/mcp",
    "env": {}
  },
  {
    "name": "linkedin",
    "aliases": [
      "ai.com.mcp/linkedin"
    ],
    "registryName": "ai.com.mcp/linkedin",
    "category": "other",
    "desc": "LinkedIn API as MCP tools to retrieve profile data and publish content. Powered by HAPI MCP.",
    "homepage": "https://github.com/la-rebelion/hapimcp",
    "version": "1.0.0+0.7.1",
    "stars": 9,
    "score": 75.571,
    "runtime": "remote",
    "transport": "http",
    "url": "https://linkedin.run.mcp.com.ai/mcp",
    "env": {}
  },
  {
    "name": "petstore",
    "aliases": [
      "ai.com.mcp/petstore"
    ],
    "registryName": "ai.com.mcp/petstore",
    "category": "other",
    "desc": "Swagger Petstore API (v1.0.27) as MCP for testing and prototyping powered by the HAPI MCP server",
    "homepage": "https://github.com/la-rebelion/hapimcp",
    "version": "0.6.0",
    "stars": 9,
    "score": 75.571,
    "runtime": "remote",
    "transport": "http",
    "url": "https://petstore.run.mcp.com.ai/mcp",
    "env": {}
  },
  {
    "name": "nauro",
    "aliases": [
      "ai.nauro/nauro",
      "Nauro-AI/nauro"
    ],
    "registryName": "ai.nauro/nauro",
    "category": "other",
    "desc": "What every agent should know",
    "homepage": "https://github.com/Nauro-AI/nauro",
    "version": "1.19.0",
    "stars": 10,
    "score": 75.387,
    "runtime": "python",
    "transport": "stdio",
    "command": "uvx",
    "args": [
      "nauro==1.19.0",
      "serve"
    ],
    "env": {}
  },
  {
    "name": "openarx",
    "aliases": [
      "ai.openarx/openarx",
      "OpenArx-AI/openarx-core"
    ],
    "registryName": "ai.openarx/openarx",
    "category": "search",
    "desc": "Open scientific and engineering knowledge for AI agents: search, evidence, document publishing.",
    "homepage": "https://github.com/OpenArx-AI/openarx-core",
    "version": "0.3.2",
    "stars": 8,
    "score": 74.105,
    "runtime": "remote",
    "transport": "http",
    "url": "https://mcp.openarx.ai/researcher/mcp",
    "env": {}
  },
  {
    "name": "mcp-perspective-ai",
    "aliases": [
      "ai.getperspective/mcp",
      "Perspective-AI/mcp"
    ],
    "registryName": "ai.getperspective/mcp",
    "category": "other",
    "desc": "An AI concierge that turns static forms into adaptive AI conversations. From any MCP client.",
    "homepage": "https://github.com/Perspective-AI/mcp",
    "version": "0.0.8",
    "stars": 5,
    "score": 73.569,
    "runtime": "remote",
    "transport": "http",
    "url": "https://getperspective.ai/mcp",
    "env": {}
  }
])
