<?php

namespace LicenceApp\Sdk\Storage;

/**
 * Where the client keeps the key, the installation id and the last signed
 * answers. Everything stored is re-verified when it is read, so a storage
 * that somebody can edit can make the client forget, never believe.
 */
interface StorageInterface
{
    public function get(string $key): ?string;

    public function set(string $key, string $value): void;

    public function remove(string $key): void;
}
