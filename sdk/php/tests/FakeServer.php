<?php

namespace LicenceApp\Sdk\Tests;

use LicenceApp\Sdk\Http\HttpClientInterface;
use LicenceApp\Sdk\Http\HttpResponse;
use LicenceApp\Sdk\Http\NetworkException;

/**
 * A license server that signs its answers with a real Ed25519 key, exactly as
 * the real one does — so every trust decision the SDK makes is exercised, not
 * assumed. The same fake as the JS SDK's suite.
 */
final class FakeServer implements HttpClientInterface
{
    public const KEY = 'WIPRO-7K4DX-82M91-QP6F3-A0ZT9';
    public const HOUR = 3600000;

    /** @var float epoch ms */
    public $now;

    /** @var bool */
    public $down = false;

    /** @var array<int, array{method: string, url: string, action: string, body: array<string, mixed>}> */
    public $calls = [];

    /** @var array<string, true> */
    public $activated = [];

    /** @var int */
    public $maxActivations;

    /** @var bool */
    public $valid = true;

    /** @var string|null */
    public $reason = null;

    /** @var string|null 'signature' | 'payload' | 'nonce' | 'product' */
    public $tamper = null;

    /** @var int|null answer every request with this status instead */
    public $status = null;

    /** @var array<string, mixed>|null */
    public $release = null;

    /** @var bool */
    public $updateAllowed = true;

    /** @var string|null */
    public $updateReason = null;

    /** @var string the bytes the download link serves */
    public $package = "PK\x03\x04fake-zip";

    /** @var string|null overrides the checksum in the signed answer */
    public $checksum = null;

    /** @var string */
    private $secretKey;

    /** @var string */
    public $publicKey;

    public function __construct(int $maxActivations = 3)
    {
        $pair = sodium_crypto_sign_keypair();
        $this->secretKey = sodium_crypto_sign_secretkey($pair);
        $this->publicKey = rtrim(strtr(base64_encode(sodium_crypto_sign_publickey($pair)), '+/', '-_'), '=');
        $this->maxActivations = $maxActivations;
        $this->now = (float) strtotime('2026-09-26T10:00:00Z') * 1000;
    }

    public function clock(): callable
    {
        return function (): float {
            return $this->now;
        };
    }

    public function send(string $method, string $url, array $headers = [], ?string $body = null): HttpResponse
    {
        if ($this->down) {
            throw new NetworkException('connection refused');
        }

        $path = (string) parse_url($url, PHP_URL_PATH);
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
        $data = $body !== null ? (array) json_decode($body, true) : $query;
        $action = basename($path);
        $this->calls[] = ['method' => $method, 'url' => $url, 'action' => $action, 'body' => $data];

        if ($this->status !== null) {
            return new HttpResponse($this->status, 'boom');
        }

        if ($action === 'download') {
            return new HttpResponse(200, $this->package);
        }

        if ($action === 'latest') {
            return $this->latest($data);
        }

        if (empty($data['product']) || empty($data['license_key'])) {
            return new HttpResponse(422, '{"error":{"code":"validation_failed"}}');
        }

        $known = $data['license_key'] === self::KEY;
        $instance = $data['instance_id'] ?? null;
        $policy = ['validation_interval_hours' => 24, 'offline_grace_days' => 7];
        $entitlements = ['pdf_export' => true, 'max_clients' => 500, 'white_label' => false];
        $envelope = $this->envelope($data['product'], $instance, $data['nonce'] ?? null);

        if ($action === 'activate') {
            if (!$known) {
                return $this->answer(['activated' => false, 'valid' => false, 'reason' => 'invalid_license', 'entitlements' => [], 'policy' => $policy] + $envelope);
            }
            if (!isset($this->activated[$instance]) && count($this->activated) >= $this->maxActivations) {
                return $this->answer(['activated' => false, 'valid' => false, 'reason' => 'activation_limit_reached', 'entitlements' => [], 'policy' => $policy] + $envelope);
            }
            $this->activated[$instance] = true;

            return $this->answer(['activated' => true, 'valid' => true, 'reason' => null, 'entitlements' => $entitlements, 'policy' => $policy] + $envelope);
        }

        if ($action === 'validate') {
            $valid = $known && $this->valid && isset($this->activated[$instance]);
            $reason = !$known ? 'invalid_license' : (!$this->valid ? $this->reason : ($valid ? null : 'not_activated'));

            return $this->answer(['valid' => $valid, 'reason' => $reason, 'entitlements' => $valid ? $entitlements : [], 'policy' => $policy] + $envelope);
        }

        if ($action === 'deactivate') {
            $was = isset($this->activated[$instance]);
            unset($this->activated[$instance]);

            return $this->answer(['deactivated' => $was, 'reason' => null] + $envelope);
        }

        return new HttpResponse(404, 'not found');
    }

    /**
     * @param array<string, mixed> $query
     */
    private function latest(array $query): HttpResponse
    {
        $release = $this->release === null ? null : $this->release + [
            'id' => 'rel_test',
            'channel' => 'stable',
            'changelog' => "Faster.\nFixes.",
            'requires' => ['wp' => '6.5', 'php' => '7.4'],
            'tested_up_to' => '6.8',
            'published_at' => '2026-09-01T00:00:00.000Z',
            'file_name' => 'invoice-pro.zip',
            'file_size' => strlen($this->package),
            'checksum_sha256' => $this->checksum ?? hash('sha256', $this->package),
        ];

        $allowed = $release !== null && $this->updateAllowed && ($query['license_key'] ?? null) === self::KEY;

        return $this->answer([
            'release' => $release,
            'update_allowed' => $allowed,
            'reason' => $allowed ? null : ($this->updateReason ?? 'license_required'),
            'download' => $allowed ? ['url' => 'https://licenses.test/api/v1/releases/rel_test/download?signature=x', 'expires_at' => '2026-09-26T10:10:00.000Z'] : null,
        ] + $this->envelope('invoice-pro', $query['instance_id'] ?? null, $query['nonce'] ?? null));
    }

    /**
     * @return array<string, mixed>
     */
    private function envelope(string $product, ?string $instance, ?string $nonce): array
    {
        return [
            'product' => $this->tamper === 'product' ? 'another-product' : $product,
            'instance_id' => $instance,
            'nonce' => $this->tamper === 'nonce' ? 'replayed-nonce' : $nonce,
            'checked_at' => gmdate('Y-m-d\TH:i:s', (int) floor($this->now / 1000)) . '.000Z',
            'request_id' => 'req_1',
        ];
    }

    /**
     * @param array<string, mixed> $payload
     */
    private function answer(array $payload): HttpResponse
    {
        $bytes = (string) json_encode($payload);
        $signature = sodium_crypto_sign_detached($bytes, $this->secretKey);

        if ($this->tamper === 'signature') {
            $signature = str_repeat("\0", SODIUM_CRYPTO_SIGN_BYTES);
        }
        if ($this->tamper === 'payload') {
            $bytes = (string) json_encode(['valid' => true, 'reason' => null] + $payload);
        }

        $signed = [
            'alg' => 'Ed25519',
            'kid' => 'k1',
            'payload' => self::b64($bytes),
            'signature' => self::b64($signature),
        ];

        return new HttpResponse(200, (string) json_encode($payload + ['signed' => $signed]));
    }

    private static function b64(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
}
