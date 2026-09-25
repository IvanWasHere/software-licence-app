<?php

/**
 * For projects without Composer — a WordPress plugin that ships the SDK in a
 * folder of its own: `require __DIR__ . '/licence-app-sdk/src/autoload.php';`
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'LicenceApp\\Sdk\\';

    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }

    $path = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';

    if (is_file($path)) {
        require $path;
    }
});
