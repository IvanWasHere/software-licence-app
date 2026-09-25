<?php

namespace LicenceApp\Sdk;

/**
 * What the client knows about the license right now.
 *
 * `reason` is one of the server's permanent codes (`invalid_license`,
 * `product_mismatch`, `license_revoked`, `license_suspended`,
 * `license_expired`, `subscription_inactive`, `not_activated`,
 * `activation_limit_reached`) or one of the SDK's own (`no_license_key`,
 * `offline_grace_expired`, `untrusted_response`).
 */
final class LicenseState
{
    /** @var bool */
    public $valid;

    /** @var string|null */
    public $reason;

    /** @var string 'network' | 'cache' | 'offline' | 'none' */
    public $source;

    /** @var bool */
    public $offline;

    /** @var array<string, mixed>|null */
    public $license;

    /** @var array<string, mixed>|null */
    public $activation;

    /** @var array<string, bool|int|string> */
    public $entitlements;

    /** @var array{validation_interval_hours: int, offline_grace_days: int} */
    public $policy;

    /** @var \DateTimeImmutable|null */
    public $checkedAt;

    /**
     * @param array<string, mixed>|null $license
     * @param array<string, mixed>|null $activation
     * @param array<string, bool|int|string> $entitlements
     * @param array{validation_interval_hours: int, offline_grace_days: int} $policy
     */
    public function __construct(
        bool $valid,
        ?string $reason,
        string $source,
        bool $offline,
        ?array $license,
        ?array $activation,
        array $entitlements,
        array $policy,
        ?\DateTimeImmutable $checkedAt
    ) {
        $this->valid = $valid;
        $this->reason = $reason;
        $this->source = $source;
        $this->offline = $offline;
        $this->license = $license;
        $this->activation = $activation;
        $this->entitlements = $entitlements;
        $this->policy = $policy;
        $this->checkedAt = $checkedAt;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'valid' => $this->valid,
            'reason' => $this->reason,
            'source' => $this->source,
            'offline' => $this->offline,
            'license' => $this->license,
            'activation' => $this->activation,
            'entitlements' => $this->entitlements,
            'policy' => $this->policy,
            'checked_at' => $this->checkedAt ? $this->checkedAt->format(DATE_ATOM) : null,
        ];
    }
}
