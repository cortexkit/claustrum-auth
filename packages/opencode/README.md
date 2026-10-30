# @cortexkit/opencode-claustrum-auth

The OpenCode 1 and OpenCode 2 package of [CortexKit Claustrum Auth](https://github.com/cortexkit/claustrum-auth). It serves provider keys from a [Claustrum](https://github.com/cortexkit/claustrum) vault for providers that need no special request handling. It is vault-only, with no local sign-in or API-key store. The Pi package is [`@cortexkit/pi-claustrum-auth`](https://www.npmjs.com/package/@cortexkit/pi-claustrum-auth).

## Install

Quit the hosts, then run:

```sh
npx @cortexkit/opencode-claustrum-auth setup
```

Setup detects OpenCode and Pi. Approve enrollment and grant access in `ck auth`, then follow the printed activation commands. Use `--host opencode` to select only OpenCode.

## Documentation

- [Supported providers and host availability](https://github.com/cortexkit/claustrum-auth#supported-providers)
- [Setup and activation](https://github.com/cortexkit/claustrum-auth/blob/main/docs/setup.md)
- [The /claustrum menu](https://github.com/cortexkit/claustrum-auth/blob/main/docs/commands.md)
- [Security](https://github.com/cortexkit/claustrum-auth/blob/main/docs/security.md)
- [Troubleshooting](https://github.com/cortexkit/claustrum-auth/blob/main/docs/troubleshooting.md)

## License

MIT
