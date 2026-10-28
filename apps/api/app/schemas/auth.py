from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    email: EmailStr



class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetVerify(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    # Same policy as signup (10-128 characters); the route also refuses the email itself.
    new_password: str = Field(min_length=10, max_length=128)


class PasswordResetAvailability(BaseModel):
    available: bool
