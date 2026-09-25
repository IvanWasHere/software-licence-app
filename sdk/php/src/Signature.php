<?php

namespace LicenceApp\Sdk;

/**
 * Opens the signed envelope every license API answer carries:
 * `{alg, kid, payload, signature}`, where `payload` is base64url of the exact
 * JSON bytes signed with Ed25519.
 *
 * The bytes are verified before they are parsed, and only the verified bytes
 * are ever parsed — nothing outside the envelope is trusted.
 */
final class Signature
{
    /**
     * @param mixed $envelope
     * @param array<string, string> $keys kid => base64url public key; `*` matches any kid
     * @return array<string, mixed>|null the payload, or null when it does not verify
     */
    public static function open($envelope, array $keys): ?array
    {
        if (!is_array($envelope)
            || ($envelope['alg'] ?? null) !== 'Ed25519'
            || !is_string($envelope['payload'] ?? null)
            || !is_string($envelope['signature'] ?? null)) {
            return null;
        }

        $kid = is_string($envelope['kid'] ?? null) ? $envelope['kid'] : '';
        $key = $keys[$kid] ?? ($keys['*'] ?? null);

        if ($key === null) {
            return null;
        }

        $publicKey = self::base64UrlDecode($key);
        $signature = self::base64UrlDecode($envelope['signature']);
        $bytes = self::base64UrlDecode($envelope['payload']);

        if ($publicKey === null || $signature === null || $bytes === null
            || strlen($publicKey) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || strlen($signature) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return null;
        }

        try {
            if (!sodium_crypto_sign_verify_detached($signature, $bytes, $publicKey)) {
                return null;
            }
        } catch (\SodiumException $e) {
            return null;
        }

        $payload = json_decode($bytes, true);

        return is_array($payload) ? $payload : null;
    }

    public static function base64UrlDecode(string $value): ?string
    {
        $decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4), true);

        return $decoded === false ? null : $decoded;
    }
}
