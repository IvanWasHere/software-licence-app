<?php

namespace LicenceApp\Sdk\Storage;

/**
 * A JSON file, written with mode 0600 — for command-line tools and apps
 * outside WordPress. Writes replace the file atomically, so a crash never
 * leaves half a record.
 */
final class FileStorage implements StorageInterface
{
    /** @var string */
    private $path;

    public function __construct(string $path)
    {
        $this->path = $path;
    }

    public function get(string $key): ?string
    {
        $values = $this->read();

        return isset($values[$key]) && is_string($values[$key]) ? $values[$key] : null;
    }

    public function set(string $key, string $value): void
    {
        $values = $this->read();
        $values[$key] = $value;
        $this->write($values);
    }

    public function remove(string $key): void
    {
        $values = $this->read();
        unset($values[$key]);
        $this->write($values);
    }

    /**
     * @return array<string, mixed>
     */
    private function read(): array
    {
        if (!is_file($this->path)) {
            return [];
        }

        $decoded = json_decode((string) file_get_contents($this->path), true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * @param array<string, mixed> $values
     */
    private function write(array $values): void
    {
        $directory = dirname($this->path);

        if (!is_dir($directory)) {
            mkdir($directory, 0700, true);
        }

        $temporary = $this->path . '.' . bin2hex(random_bytes(4)) . '.tmp';
        file_put_contents($temporary, json_encode($values));
        chmod($temporary, 0600);
        rename($temporary, $this->path);
    }
}
