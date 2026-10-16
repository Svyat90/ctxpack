<?php

namespace App\Services;

use App\Services\Contracts\ServiceContract;
use Illuminate\Support\Traits\Macroable;

abstract class BaseService implements ServiceContract
{
    use Macroable;
}
