<?php

namespace Tests\Feature;

use App\Http\Controllers\UserController;
use Tests\TestCase;

class UserControllerTest extends TestCase
{
    public function test_index_renders(): void
    {
        $this->get(action([UserController::class, 'index']))->assertOk();
    }
}
