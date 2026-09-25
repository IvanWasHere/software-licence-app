<?php

namespace LicenceApp\Sdk;

use LicenceApp\Sdk\Http\CurlHttpClient;
use LicenceApp\Sdk\Http\HttpClientInterface;
use LicenceApp\Sdk\Http\HttpResponse;
use LicenceApp\Sdk\Http\NetworkException;
use LicenceApp\Sdk\Storage\MemoryStorage;
use LicenceApp\Sdk\Storage\StorageInterface;

/**
 * A license client for one product on one installation — the PHP twin of
 * `@licence-app/sdk`, with the same contract:
 *
 * 1. A cached answer younger than the product's `validation_interval_hours`
 *    is reused; a "no" is reused for an hour.
 * 2. Otherwise the server is asked, with a fresh nonce. The answer counts only
 *    if its signature verifies against a pinned key and it echoes this
 *    request's nonce, product and installation.
 * 3. If the server cannot be reached, the last good answer stands, marked
 *    offline, while it is younger than `offline_grace_days`; after that the
 *    state is `offline_grace_expired`.
 * 4. It never switches anything off by itself. It reports; the software
 *    decides what to lock.
 *
 * Every age is measured from the signed `checked_at`, so an edited cache
 * cannot make an old answer look fresh. The record it stores has the same
 * shape as the JS SDK's.
 */
final class Client
{
    private const HOUR_MS = 3600000;
    private const DEFAULT_POLICY = ['validation_interval_hours' => 24, 'offline_grace_days' => 7];

    /** @var string */
    private $baseUrl;

    /** @var string */
    private $product;

    /** @var array<string, string> */
    private $keys;

    /** @var StorageInterface */
    private $storage;

    /** @var HttpClientInterface */
    private $http;

    /** @var string|null */
    private $instanceId;

    /** @var string|null */
    private $clientVersion;

    /** @var callable(): float */
    private $now;

    /** @var int */
    private $invalidCacheMinutes;

    /** @var callable(LicenseState): void|null */
    private $onChange;

    /** @var string */
    private $storageKey;

    /** @var LicenseState */
    private $state;

    /**
     * @param array{
     *   base_url: string,
     *   product: string,
     *   public_key: string|array<string, string>,
     *   storage?: StorageInterface,
     *   http?: HttpClientInterface,
     *   instance_id?: string,
     *   client_version?: string,
     *   now?: callable(): float,
     *   invalid_cache_minutes?: int,
     *   on_change?: callable(LicenseState): void
     * } $options
     *
     * `public_key` is the server's response-signing key(s), base64url of the
     * raw 32 bytes, from `GET /api/v1/keys`. Pin it in your build — fetching
     * it at runtime would let whoever answers that request vouch for itself.
     * A map pins keys by `kid`, which is what carries you across a rotation.
     */
    public function __construct(array $options)
    {
        if (empty($options['base_url']) || empty($options['product']) || empty($options['public_key'])) {
            throw new \InvalidArgumentException('base_url, product and public_key are required');
        }

        $this->baseUrl = rtrim($options['base_url'], '/');
        $this->product = $options['product'];
        $this->keys = is_string($options['public_key']) ? ['*' => $options['public_key']] : $options['public_key'];
        $this->storage = $options['storage'] ?? new MemoryStorage();
        $this->http = $options['http'] ?? new CurlHttpClient();
        $this->instanceId = $options['instance_id'] ?? null;
        $this->clientVersion = $options['client_version'] ?? null;
        $this->now = $options['now'] ?? static function (): float {
            return microtime(true) * 1000;
        };
        $this->invalidCacheMinutes = $options['invalid_cache_minutes'] ?? 60;
        $this->onChange = $options['on_change'] ?? null;
        $this->storageKey = 'licence-app:' . $this->product;
        $this->state = self::emptyState('no_license_key');
    }

    /** The last state reported, without asking anybody. */
    public function state(): LicenseState
    {
        return $this->state;
    }

    public function product(): string
    {
        return $this->product;
    }

    /** Whether a boolean entitlement is on — or any other kind is set to something. */
    public function has(string $entitlement): bool
    {
        $value = $this->state->valid ? ($this->state->entitlements[$entitlement] ?? null) : null;

        return $value !== null && $value !== false && $value !== 0 && $value !== '';
    }

    /**
     * An entitlement's value, or `$fallback` when the license is not valid or lacks it.
     *
     * @param bool|int|string|null $fallback
     * @return bool|int|string|null
     */
    public function get(string $entitlement, $fallback = null)
    {
        if (!$this->state->valid || !array_key_exists($entitlement, $this->state->entitlements)) {
            return $fallback;
        }

        return $this->state->entitlements[$entitlement];
    }

    /** The key this installation was activated with, if any. */
    public function licenseKey(): ?string
    {
        return $this->load()['licenseKey'];
    }

    /** The id this installation activates as. Generated and stored on first use. */
    public function instanceId(): string
    {
        return $this->load()['instanceId'];
    }

    /**
     * Activate this installation with a key the customer typed. Throws only
     * when the server cannot be asked at all; a refusal (wrong key, no slots
     * left) is a state with a reason, and the key is then not remembered.
     *
     * @param array{site_url?: string, label?: string} $options
     * @throws LicenseSdkException
     */
    public function activate(string $licenseKey, array $options = []): LicenseState
    {
        $record = $this->load();
        $key = trim($licenseKey);

        $answer = $this->ask('activate', [
            'license_key' => $key,
            'instance_id' => $record['instanceId'],
            'site_url' => $options['site_url'] ?? null,
            'label' => $options['label'] ?? null,
            'client_version' => $this->clientVersion,
        ]);

        if ($answer['payload'] === null) {
            throw $answer['untrusted']
                ? new LicenseSdkException(
                    'The license server answered, but not with a signature this build trusts. Check the pinned public key.',
                    LicenseSdkException::UNTRUSTED_RESPONSE
                )
                : new LicenseSdkException('The license server could not be reached', LicenseSdkException::NETWORK);
        }

        if (!empty($answer['payload']['activated'])) {
            $record['licenseKey'] = $key;
            $record['answer'] = $answer['envelope'];
            $record['lastGood'] = $answer['envelope'];
            $this->save($record);
        }

        return $this->report(self::stateFrom($answer['payload'], 'network'));
    }

    /**
     * Is this installation licensed? Answers from the cache when it is fresh
     * enough, asks the server otherwise, and falls back to the last good
     * answer while offline. `$force` skips the cache.
     */
    public function validate(bool $force = false): LicenseState
    {
        $record = $this->load();

        if ($record['licenseKey'] === null) {
            return $this->report(self::emptyState('no_license_key'));
        }

        $cached = Signature::open($record['answer'], $this->keys);

        if (!$force && $cached !== null && $this->isFresh($cached)) {
            return $this->report(self::stateFrom($cached, 'cache'));
        }

        $answer = $this->ask('validate', [
            'license_key' => $record['licenseKey'],
            'instance_id' => $record['instanceId'],
        ]);

        if ($answer['payload'] !== null) {
            $record['answer'] = $answer['envelope'];
            if (!empty($answer['payload']['valid'])) {
                $record['lastGood'] = $answer['envelope'];
            }
            $this->save($record);

            return $this->report(self::stateFrom($answer['payload'], 'network'));
        }

        return $this->report($this->offline($record, $answer['untrusted']));
    }

    /**
     * Release this installation's slot and forget the key here. The key is
     * forgotten even when the server cannot be reached — the customer asked
     * to remove it — and the slot can then be freed from their account.
     */
    public function deactivate(): bool
    {
        $record = $this->load();

        if ($record['licenseKey'] === null) {
            return false;
        }

        try {
            $answer = $this->ask('deactivate', [
                'license_key' => $record['licenseKey'],
                'instance_id' => $record['instanceId'],
            ]);
        } catch (LicenseSdkException $e) {
            $answer = ['payload' => null];
        }

        $record['licenseKey'] = null;
        $record['answer'] = null;
        $record['lastGood'] = null;
        $this->save($record);
        $this->report(self::emptyState('no_license_key'));

        return !empty($answer['payload']['deactivated']);
    }

    /**
     * The newest build on `$channel`, and a download link when this license
     * covers it. `null` when the server could not be asked or the answer did
     * not verify — "no update information", never "no update".
     */
    public function latestRelease(string $channel = 'stable'): ?UpdateCheck
    {
        $record = $this->load();
        $nonce = self::nonce();

        $query = array_filter([
            'channel' => $channel,
            'license_key' => $record['licenseKey'],
            'instance_id' => $record['licenseKey'] !== null ? $record['instanceId'] : null,
            'nonce' => $nonce,
        ], static function ($value) {
            return $value !== null;
        });

        try {
            $response = $this->http->send(
                'GET',
                $this->baseUrl . '/products/' . rawurlencode($this->product) . '/releases/latest?' . http_build_query($query),
                ['accept' => 'application/json']
            );
        } catch (NetworkException $e) {
            return null;
        }

        if ($response->status !== 200) {
            return null;
        }

        $payload = $this->verified($response, $nonce, $query['instance_id'] ?? null);

        if ($payload === null) {
            return null;
        }

        $download = is_array($payload['download'] ?? null) ? $payload['download'] : null;

        return new UpdateCheck(
            is_array($payload['release'] ?? null) ? $payload['release'] : null,
            !empty($payload['update_allowed']),
            isset($payload['reason']) ? (string) $payload['reason'] : null,
            $download && is_string($download['url'] ?? null) ? $download['url'] : null
        );
    }

    /**
     * One call to the license API. Returns the payload only when the answer
     * is signed by a pinned key and echoes the nonce, product and installation
     * of this request; anything else is `untrusted` and treated like no answer.
     *
     * @param array<string, string|null> $body
     * @return array{payload: array<string, mixed>|null, envelope: array<string, mixed>|null, untrusted: bool}
     * @throws LicenseSdkException on a 422
     */
    private function ask(string $action, array $body): array
    {
        $nonce = self::nonce();
        $body = array_filter(
            array_merge(['product' => $this->product, 'nonce' => $nonce], $body),
            static function ($value) {
                return $value !== null;
            }
        );

        try {
            $response = $this->http->send(
                'POST',
                $this->baseUrl . '/licenses/' . $action,
                ['content-type' => 'application/json', 'accept' => 'application/json'],
                (string) json_encode($body)
            );
        } catch (NetworkException $e) {
            return ['payload' => null, 'envelope' => null, 'untrusted' => false];
        }

        if ($response->status === 422) {
            throw new LicenseSdkException(
                'The license server refused the request: ' . $response->body,
                LicenseSdkException::REJECTED_REQUEST
            );
        }

        if ($response->status < 200 || $response->status >= 300) {
            return ['payload' => null, 'envelope' => null, 'untrusted' => false];
        }

        $decoded = json_decode($response->body, true);
        $envelope = is_array($decoded) && is_array($decoded['signed'] ?? null) ? $decoded['signed'] : null;
        $payload = $this->verified($response, $nonce, $body['instance_id'] ?? null);

        return $payload !== null
            ? ['payload' => $payload, 'envelope' => $envelope, 'untrusted' => false]
            : ['payload' => null, 'envelope' => null, 'untrusted' => true];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function verified(HttpResponse $response, string $nonce, ?string $instanceId): ?array
    {
        $decoded = json_decode($response->body, true);
        $payload = Signature::open(is_array($decoded) ? ($decoded['signed'] ?? null) : null, $this->keys);

        if ($payload === null
            || ($payload['nonce'] ?? null) !== $nonce
            || ($payload['product'] ?? null) !== $this->product
            || ($payload['instance_id'] ?? null) !== $instanceId) {
            return null;
        }

        return $payload;
    }

    /**
     * @param array<string, mixed> $record
     */
    private function offline(array $record, bool $untrusted): LicenseState
    {
        $lastGood = Signature::open($record['lastGood'], $this->keys);

        if ($lastGood !== null) {
            $graceMs = self::policyOf($lastGood)['offline_grace_days'] * 24 * self::HOUR_MS;

            if ($this->ageOf($lastGood) < $graceMs) {
                $state = self::stateFrom($lastGood, 'offline');
                $state->offline = true;

                return $state;
            }
        }

        $state = self::emptyState($untrusted ? 'untrusted_response' : 'offline_grace_expired');
        $state->source = 'offline';
        $state->offline = true;

        return $state;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function isFresh(array $payload): bool
    {
        $age = $this->ageOf($payload);

        if ($age < 0) {
            return false;
        }

        return !empty($payload['valid'])
            ? $age < self::policyOf($payload)['validation_interval_hours'] * self::HOUR_MS
            : $age < $this->invalidCacheMinutes * 60000;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function ageOf(array $payload): float
    {
        $checkedAt = self::parseTime($payload['checked_at'] ?? null);

        return $checkedAt === null ? INF : ($this->now)() - $checkedAt;
    }

    private function report(LicenseState $state): LicenseState
    {
        $previous = $this->state;
        $this->state = $state;

        if ($this->onChange !== null && ($previous->valid !== $state->valid || $previous->reason !== $state->reason)) {
            ($this->onChange)($state);
        }

        return $state;
    }

    /**
     * @return array{v: int, licenseKey: string|null, instanceId: string, answer: array<string, mixed>|null, lastGood: array<string, mixed>|null}
     */
    private function load(): array
    {
        $raw = $this->storage->get($this->storageKey);
        $record = $raw !== null ? json_decode($raw, true) : null;

        if (is_array($record) && ($record['v'] ?? null) === 1 && is_string($record['instanceId'] ?? null)) {
            return [
                'v' => 1,
                'licenseKey' => is_string($record['licenseKey'] ?? null) ? $record['licenseKey'] : null,
                'instanceId' => $record['instanceId'],
                'answer' => is_array($record['answer'] ?? null) ? $record['answer'] : null,
                'lastGood' => is_array($record['lastGood'] ?? null) ? $record['lastGood'] : null,
            ];
        }

        $fresh = [
            'v' => 1,
            'licenseKey' => null,
            'instanceId' => $this->instanceId ?? self::uuid(),
            'answer' => null,
            'lastGood' => null,
        ];

        $this->save($fresh);

        return $fresh;
    }

    /**
     * @param array<string, mixed> $record
     */
    private function save(array $record): void
    {
        $this->storage->set($this->storageKey, (string) json_encode($record));
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{validation_interval_hours: int, offline_grace_days: int}
     */
    private static function policyOf(array $payload): array
    {
        $policy = $payload['policy'] ?? null;

        return is_array($policy)
            ? [
                'validation_interval_hours' => (int) ($policy['validation_interval_hours'] ?? 24),
                'offline_grace_days' => (int) ($policy['offline_grace_days'] ?? 7),
            ]
            : self::DEFAULT_POLICY;
    }

    /**
     * @param array<string, mixed> $payload
     */
    private static function stateFrom(array $payload, string $source): LicenseState
    {
        $valid = (bool) ($payload['valid'] ?? ($payload['activated'] ?? false));
        $checkedAt = self::parseTime($payload['checked_at'] ?? null);

        return new LicenseState(
            $valid,
            isset($payload['reason']) ? (string) $payload['reason'] : null,
            $source,
            false,
            is_array($payload['license'] ?? null) ? $payload['license'] : null,
            is_array($payload['activation'] ?? null) ? $payload['activation'] : null,
            $valid && is_array($payload['entitlements'] ?? null) ? $payload['entitlements'] : [],
            self::policyOf($payload),
            $checkedAt === null ? null : (new \DateTimeImmutable('@' . (int) floor($checkedAt / 1000)))
        );
    }

    private static function emptyState(string $reason): LicenseState
    {
        return new LicenseState(false, $reason, 'none', false, null, null, [], self::DEFAULT_POLICY, null);
    }

    /**
     * Epoch milliseconds of an ISO-8601 timestamp, or null.
     *
     * @param mixed $value
     */
    private static function parseTime($value): ?float
    {
        if (!is_string($value) || $value === '') {
            return null;
        }

        try {
            $time = new \DateTimeImmutable($value);
        } catch (\Exception $e) {
            return null;
        }

        return (float) $time->format('U.u') * 1000;
    }

    private static function nonce(): string
    {
        return bin2hex(random_bytes(16));
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
