# @cortexkit/pi-claustrum-auth

The Pi extension of [CortexKit Claustrum Auth](https://github.com/cortexkit/claustrum-auth). It serves provider keys from a [Claustrum](https://github.com/cortexkit/claustrum) vault for providers that need no special request handling. It is vault-only, with no local sign-in or API-key store. OpenCode 1 and 2 use [`@cortexkit/opencode-claustrum-auth`](https://www.npmjs.com/package/@cortexkit/opencode-claustrum-auth), which also provides the shared setup command.

## Install

Quit Pi, then run:

```sh
npx @cortexkit/opencode-claustrum-auth setup --host pi
```

Approve enrollment and grant access in `ck auth`, then activate a provider with `/claustrum use <provider>` inside Pi. Pi asks for consent before moving an existing login aside.

## Documentation

- [Supported providers and host availability](https://github.com/cortexkit/claustrum-auth#supported-providers)
- [Setup and activation](https://github.com/cortexkit/claustrum-auth/blob/main/docs/setup.md)
- [The /claustrum menu](https://github.com/cortexkit/claustrum-auth/blob/main/docs/commands.md)
- [Security](https://github.com/cortexkit/claustrum-auth/blob/main/docs/security.md)
- [Troubleshooting](https://github.com/cortexkit/claustrum-auth/blob/main/docs/troubleshooting.md)

## License

MIT
