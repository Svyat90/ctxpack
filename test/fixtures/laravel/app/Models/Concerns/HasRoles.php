<?php

namespace App\Models\Concerns;

trait HasRoles
{
    public function hasRole(string $role): bool
    {
        return $this->role === $role;
    }
}
