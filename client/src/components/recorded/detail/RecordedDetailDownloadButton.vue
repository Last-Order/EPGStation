<template>
    <div class="mr-2">
        <v-btn v-on:click="openDialog" title="download">
            <v-icon>mdi-download</v-icon>
        </v-btn>
        <RecordedDownloadDialog
            :isOpen.sync="isOpen"
            :videoFiles="videoFiles"
            :recordedItem="recordedItem"
            v-on:download="onDownload"
            v-on:downloadPlayList="onDownloadPlayList"
        ></RecordedDownloadDialog>
    </div>
</template>

<script lang="ts">
import RecordedDownloadDialog from '@/components/recorded/RecordedDownloadDialog.vue';
import { Component, Prop, Vue } from 'vue-property-decorator';
import * as apid from '../../../../../api';

@Component({
    components: {
        RecordedDownloadDialog,
    },
})
export default class RecordedDetailDownloadButton extends Vue {
    @Prop({ required: true })
    public videoFiles!: apid.VideoFile[];

    @Prop({ required: true })
    public recordedItem!: apid.RecordedItem;

    public isOpen: boolean = false;

    public openDialog(): void {
        this.isOpen = true;
    }

    public onDownload(video: apid.VideoFile): void {
        this.$emit('download', video);
        this.isOpen = false;
    }

    public onDownloadPlayList(video: apid.VideoFile): void {
        this.$emit('downloadPlayList', video);
        this.isOpen = false;
    }
}
</script>

<style lang="sass" scoped>
.mr-2 {
    margin-right: 8px !important;
}
</style>
