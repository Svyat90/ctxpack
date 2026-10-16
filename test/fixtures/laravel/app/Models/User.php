<?php

namespace App\Models;

use App\Models\Concerns\HasRoles;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;

/**
 * @property int $id
 * @property string $email
 * @property-read \Illuminate\Database\Eloquent\Collection<int, \App\Models\Order> $orders
 * @method static \Illuminate\Database\Eloquent\Builder<static>|User newModelQuery()
 * @method static \Illuminate\Database\Eloquent\Builder<static>|User whereEmail($value)
 * @mixin \Eloquent
 */
class User extends Authenticatable
{
    use HasFactory, HasRoles;

    protected $fillable = ['name', 'email', 'password'];
}
