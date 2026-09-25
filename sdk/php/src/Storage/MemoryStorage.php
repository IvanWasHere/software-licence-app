<?php

namespace LicenceApp\Sdk\Storage;

/**
 * For tests and one-off scripts: forgotten when the process ends.
 */
final class MemoryStorage implements StorageInterface
{
    /** @var array<string, string> */
    private $values = [];

    public function get(string $key): ?string
    {
        return $this->values[$key] ?? null;
    }

    public function set(string $key, string $value): void
    {
        $this->values[$key] = $value;
    }

    public function remove(string $key): void
    {
        unset($this->values[$key]);
    }
}
