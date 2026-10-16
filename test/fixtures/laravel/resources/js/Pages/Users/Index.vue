<script setup>
import { Head } from '@inertiajs/vue3';
import { ref } from 'vue';
import AppLayout from '@/Layouts/AppLayout.vue';
import DataTable from '@/Components/DataTable.vue';

const search = ref('');
const indexUrl = route('users.index');
</script>

<template>
  <AppLayout>
    <Head title="Users" />
    <DataTable :search="search" :url="indexUrl" />
  </AppLayout>
</template>
