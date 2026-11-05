export const GoogleSignin = {
  configure: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
};

export function isSuccessResponse(response: { type?: string }): boolean {
  return response.type === 'success';
}

export const statusCodes = {
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  IN_PROGRESS: 'IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
  NULL_PRESENTER: 'NULL_PRESENTER',
};
