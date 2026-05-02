import { requireNativeModule } from 'expo';

import type { InfchatMediaTransferModule } from './InfchatMediaTransfer.types';

export default requireNativeModule<InfchatMediaTransferModule>('InfchatMediaTransfer');
