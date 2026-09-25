<?php

namespace LicenceApp\Sdk;

/**
 * A verified answer from `releases/latest`: the newest build on a channel,
 * and — when this license covers it — a link to download it.
 */
final class UpdateCheck
{
    /**
     * The release as the server described it: `id`, `version`, `channel`,
     * `changelog`, `requires` (e.g. `['wp' => '6.5', 'php' => '7.4']`),
     * `tested_up_to`, `published_at`, `file_name`, `file_size`,
     * `checksum_sha256`. `null` when nothing is published.
     *
     * @var array<string, mixed>|null
     */
    public $release;

    /** @var bool */
    public $updateAllowed;

    /**
     * Why there is no download: a license reason, `updates_expired` or
     * `license_required`.
     *
     * @var string|null
     */
    public $reason;

    /**
     * Works for ten minutes. Fetch a fresh check right before downloading.
     *
     * @var string|null
     */
    public $downloadUrl;

    /**
     * @param array<string, mixed>|null $release
     */
    public function __construct(?array $release, bool $updateAllowed, ?string $reason, ?string $downloadUrl)
    {
        $this->release = $release;
        $this->updateAllowed = $updateAllowed;
        $this->reason = $reason;
        $this->downloadUrl = $downloadUrl;
    }

    /**
     * @return array{release: array<string, mixed>|null, update_allowed: bool, reason: string|null, download_url: string|null}
     */
    public function toArray(): array
    {
        return [
            'release' => $this->release,
            'update_allowed' => $this->updateAllowed,
            'reason' => $this->reason,
            'download_url' => $this->downloadUrl,
        ];
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            is_array($data['release'] ?? null) ? $data['release'] : null,
            !empty($data['update_allowed']),
            isset($data['reason']) ? (string) $data['reason'] : null,
            isset($data['download_url']) ? (string) $data['download_url'] : null
        );
    }

    public function version(): ?string
    {
        return $this->release ? (string) $this->release['version'] : null;
    }

    public function checksum(): ?string
    {
        return $this->release ? (string) $this->release['checksum_sha256'] : null;
    }

    /**
     * Whether the release is newer than `$installedVersion`.
     */
    public function isNewerThan(string $installedVersion): bool
    {
        $version = $this->version();

        return $version !== null && version_compare(self::normalize($version), self::normalize($installedVersion), '>');
    }

    /**
     * PHP's `version_compare` reads `1.0.0-beta.1` differently from semver;
     * this maps the common pre-release names onto what it understands.
     */
    private static function normalize(string $version): string
    {
        $version = ltrim($version, 'vV');
        $version = preg_replace('/\+.*$/', '', $version) ?? $version;

        return str_replace(['-alpha', '-beta', '-rc'], ['alpha', 'beta', 'RC'], $version);
    }
}
