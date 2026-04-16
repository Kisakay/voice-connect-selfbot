# voice connect selfbot

a shitty repo for shitty use

## How to use it ?
In **`tokens.json`** :
```json
[
  {
    "token": "user token",
    "voiceChannelId": "voice channel id",
    "status": "online",
    "selfMute": true,
    "selfDeaf": true,
    "selfVideo": false,
    "selfStream": false
  }
]
```
> Status can be: online, dnd, idle, invisible
> selfMute, selfDeaf, selfVideo and selfStream are booleans

## Requirement:

- NodeJS v22+ or Bun

## Start

```bash
npm start
```
